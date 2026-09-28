import os
import torch
import torch.nn.functional as F
from torch_geometric.datasets import EllipticBitcoinDataset
from torch_geometric.nn import GATv2Conv
from torch.optim import Adam
from torch.optim.lr_scheduler import ReduceLROnPlateau

# -----------------------------------------------------------------------------
# 1. Dataset Loading
# -----------------------------------------------------------------------------
print("Loading EllipticBitcoinDataset...")
dataset = EllipticBitcoinDataset(root='./data/Elliptic')
data = dataset[0]

print(f"Dataset loaded. Number of nodes: {data.num_nodes}")
print(f"Number of edges: {data.num_edges}")
print(f"Number of node features: {dataset.num_node_features}")

# -----------------------------------------------------------------------------
# 2. Advanced Model Definition: Graph Attention Network v2 (GATv2)
# -----------------------------------------------------------------------------
class AdvancedGNN(torch.nn.Module):
    def __init__(self, in_channels, hidden_channels, out_channels, heads=4):
        super(AdvancedGNN, self).__init__()
        # GATv2 is more expressive than standard GCN, paying 'attention' to important neighbors
        self.conv1 = GATv2Conv(in_channels, hidden_channels, heads=heads, dropout=0.4)
        # We multiply hidden_channels by heads because GAT concatenates the head outputs by default
        self.conv2 = GATv2Conv(hidden_channels * heads, hidden_channels, heads=heads, dropout=0.4)
        self.conv3 = GATv2Conv(hidden_channels * heads, out_channels, heads=1, concat=False, dropout=0.4)

    def forward(self, x, edge_index):
        x = F.elu(self.conv1(x, edge_index))
        x = F.dropout(x, p=0.4, training=self.training)
        
        # Skip connection for better gradient flow
        x2 = F.elu(self.conv2(x, edge_index))
        x = x + x2 # Residual connection
        x = F.dropout(x, p=0.4, training=self.training)
        
        x = self.conv3(x, edge_index)
        return x

# -----------------------------------------------------------------------------
# 3. Setup Training Configuration
# -----------------------------------------------------------------------------
device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
print(f"Using device: {device}")

data = data.to(device)

model = AdvancedGNN(
    in_channels=dataset.num_node_features,
    hidden_channels=64,
    out_channels=2,
    heads=4
).to(device)

optimizer = Adam(model.parameters(), lr=0.005, weight_decay=1e-4)
# Scheduler reduces learning rate when validation loss stops improving
scheduler = ReduceLROnPlateau(optimizer, mode='min', factor=0.5, patience=10, verbose=True)

# The Elliptic dataset automatically provides proper train_mask and test_mask 
# which are temporally split (steps 1-34 for train, 35-49 for test).
train_mask = data.train_mask
test_mask = data.test_mask

# We must ensure we only calculate metrics on labeled data (ignore class 2)
labeled_mask = (data.y == 0) | (data.y == 1)
train_mask = train_mask & labeled_mask
test_mask = test_mask & labeled_mask

# Handle severe Class Imbalance
# The dataset has vastly more licit (1) nodes than illicit (0) nodes.
# We calculate class weights so the model doesn't just guess "licit" every time.
num_illicit = (data.y[train_mask] == 0).sum().item()
num_licit = (data.y[train_mask] == 1).sum().item()
total_train = num_illicit + num_licit

# Weight = Total / (Num_Classes * Count)
weight_illicit = total_train / (2 * num_illicit) if num_illicit > 0 else 1.0
weight_licit = total_train / (2 * num_licit) if num_licit > 0 else 1.0
class_weights = torch.tensor([weight_illicit, weight_licit], dtype=torch.float).to(device)

print(f"Class Weights - Illicit: {weight_illicit:.2f}, Licit: {weight_licit:.2f}")

criterion = torch.nn.CrossEntropyLoss(weight=class_weights)

# -----------------------------------------------------------------------------
# 4. Training Loop with Early Stopping & Best Model Saving
# -----------------------------------------------------------------------------
def train():
    model.train()
    optimizer.zero_grad()
    out = model(data.x, data.edge_index)
    loss = criterion(out[train_mask], data.y[train_mask])
    loss.backward()
    optimizer.step()
    return loss.item()

def test():
    model.eval()
    with torch.no_grad():
        out = model(data.x, data.edge_index)
        pred = out.argmax(dim=1)
        
        loss_val = criterion(out[test_mask], data.y[test_mask]).item()
        
        # Calculate Precision, Recall, F1 for the Illicit class (0)
        true_positive = ((pred[test_mask] == 0) & (data.y[test_mask] == 0)).sum().item()
        false_positive = ((pred[test_mask] == 0) & (data.y[test_mask] == 1)).sum().item()
        false_negative = ((pred[test_mask] == 1) & (data.y[test_mask] == 0)).sum().item()
        
        accuracy = (pred[test_mask] == data.y[test_mask]).sum().item() / test_mask.sum().item()
        precision = true_positive / (true_positive + false_positive) if (true_positive + false_positive) > 0 else 0
        recall = true_positive / (true_positive + false_negative) if (true_positive + false_negative) > 0 else 0
        f1 = 2 * (precision * recall) / (precision + recall) if (precision + recall) > 0 else 0
        
    return loss_val, accuracy, precision, recall, f1

epochs = 500
best_f1 = 0
patience_counter = 0
early_stop_patience = 50
model_path = 'model_advanced.pth'

print(f"Starting advanced training for up to {epochs} epochs...")

for epoch in range(1, epochs + 1):
    train_loss = train()
    val_loss, acc, prec, rec, f1 = test()
    scheduler.step(val_loss)
    
    if f1 > best_f1:
        best_f1 = f1
        patience_counter = 0
        torch.save(model.state_dict(), model_path)
    else:
        patience_counter += 1
        
    if epoch % 10 == 0 or epoch == 1:
        print(f"Epoch {epoch:03d} | Train Loss: {train_loss:.4f} | Val Loss: {val_loss:.4f} | "
              f"Acc: {acc:.4f} | Illicit F1: {f1:.4f} | Recall: {rec:.4f}")
              
    if patience_counter >= early_stop_patience:
        print(f"Early stopping triggered at epoch {epoch}. Best Illicit F1: {best_f1:.4f}")
        break

print(f"Training complete. Best model weights saved to {model_path}.")
