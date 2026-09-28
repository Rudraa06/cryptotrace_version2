import requests
import json
import random

# Create a mock graph with 3 nodes and 2 edges
# The AdvancedGNN expects exactly 166 features per node
num_nodes = 3
num_features = 166

# Generate random features for the 3 nodes
x = [[random.uniform(0, 1) for _ in range(num_features)] for _ in range(num_nodes)]

# Create edges: 0 -> 1, and 1 -> 2
edge_index = [
    [0, 1], # Source nodes
    [1, 2]  # Target nodes
]

payload = {
    "x": x,
    "edge_index": edge_index
}

url = "http://localhost:8000/predict"
print(f"Sending POST request to {url} with a {num_nodes}-node graph...")

try:
    response = requests.post(url, json=payload)
    if response.status_code == 200:
        data = response.json()
        print("\nSUCCESS! Received probability scores:")
        for i, prob in enumerate(data['illicit_probabilities']):
            print(f"  Node {i} - Illicit Probability: {prob * 100:.2f}%")
    else:
        print(f"ERROR {response.status_code}: {response.text}")
except requests.exceptions.ConnectionError:
    print("ERROR: Could not connect. Is the FastAPI server running on port 8000?")
