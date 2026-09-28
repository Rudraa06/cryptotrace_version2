import os
import torch
import torch.nn.functional as F
from torch_geometric.nn import GATv2Conv
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import List

# -----------------------------------------------------------------------------
# 1. Model Definition (Must perfectly match the training script structure)
# -----------------------------------------------------------------------------
class AdvancedGNN(torch.nn.Module):
    def __init__(self, in_channels, hidden_channels, out_channels, heads=4):
        super(AdvancedGNN, self).__init__()
        self.conv1 = GATv2Conv(in_channels, hidden_channels, heads=heads, dropout=0.4)
        self.conv2 = GATv2Conv(hidden_channels * heads, hidden_channels, heads=heads, dropout=0.4)
        self.conv3 = GATv2Conv(hidden_channels * heads, out_channels, heads=1, concat=False, dropout=0.4)

    def forward(self, x, edge_index):
        x = F.elu(self.conv1(x, edge_index))
        # Note: we disable dropout during inference natively by using model.eval(), 
        # so training=self.training ensures no random node dropping during predictions.
        x = F.dropout(x, p=0.4, training=self.training)
        
        x2 = F.elu(self.conv2(x, edge_index))
        x = x + x2 
        x = F.dropout(x, p=0.4, training=self.training)
        
        x = self.conv3(x, edge_index)
        return x

# -----------------------------------------------------------------------------
# 2. FastAPI Application Setup
# -----------------------------------------------------------------------------
app = FastAPI(
    title="CryptoTrace ML Inference Service",
    description="Serves the PyTorch Geometric AdvancedGNN model for live wallet scoring.",
    version="1.0.0"
)

# Global model instance
model = None
device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')

@app.on_event("startup")
async def load_model():
    """Loads the model_advanced.pth weights into memory on server boot."""
    global model
    model_path = os.path.join(os.path.dirname(__file__), 'model_advanced.pth')
    
    if not os.path.exists(model_path):
        raise RuntimeError(f"Model file not found at {model_path}. Did you forget to move it here after Colab training?")
    
    # The Elliptic dataset uses 165 features in PyTorch Geometric (1 time step + 164 features)
    model = AdvancedGNN(in_channels=165, hidden_channels=64, out_channels=2, heads=4)
    
    # Load weights (map_location ensures it loads even if the server lacks a GPU)
    model.load_state_dict(torch.load(model_path, map_location=device))
    model.to(device)
    model.eval() # CRITICAL: Sets dropout layers to bypass mode
    
    print(f"✅ CryptoTrace GATv2 Model successfully loaded on {device}.")

# -----------------------------------------------------------------------------
# 3. Request/Response Data Models
# -----------------------------------------------------------------------------
class PredictionRequest(BaseModel):
    # A list of nodes, where each node is a list of 166 float features
    x: List[List[float]]
    # A list containing two lists (source nodes, destination nodes) representing the graph edges
    edge_index: List[List[int]] 

class PredictionResponse(BaseModel):
    # List of illicit probabilities for each node in the exact order they were provided in `x`
    illicit_probabilities: List[float]

# -----------------------------------------------------------------------------
# 4. Inference Endpoint
# -----------------------------------------------------------------------------
@app.post("/predict", response_model=PredictionResponse)
async def predict_nodes(request: PredictionRequest):
    if not model:
        raise HTTPException(status_code=503, detail="Model is currently unavailable or still loading.")
        
    try:
        # Convert raw JSON arrays to PyTorch Tensors
        x_tensor = torch.tensor(request.x, dtype=torch.float).to(device)
        edge_index_tensor = torch.tensor(request.edge_index, dtype=torch.long).to(device)
        
        # Verify edge_index shape (must be 2 x E)
        if edge_index_tensor.shape[0] != 2:
            raise ValueError("edge_index must be a 2D array of shape [2, num_edges].")

        # Run inference without tracking gradients (faster, less memory)
        with torch.no_grad():
            logits = model(x_tensor, edge_index_tensor)
            
            # Convert raw logits to probabilities via Softmax (dim=1 because shape is N x 2)
            probabilities = F.softmax(logits, dim=1)
            
            # The Elliptic Dataset maps: Class 0 = Illicit. 
            # We want the probability of Class 0 for all nodes.
            illicit_probs = probabilities[:, 0].cpu().tolist()
            
            return PredictionResponse(illicit_probabilities=illicit_probs)
            
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
