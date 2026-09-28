# CryptoTrace ML Microservice

This Python/FastAPI microservice runs a Graph Neural Network (GNN) model designed to detect if a wallet behaves like an Over-The-Counter (OTC) broker by analyzing its 2-hop transaction neighborhood.

## Setup

1. Make sure you have Python 3.9+ installed.
2. Create and activate a virtual environment:
   ```bash
   python -m venv .venv
   # Windows:
   .venv\Scripts\activate
   # macOS/Linux:
   source .venv/bin/activate
   ```
3. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```

## Configuration

This service reads directly from your Neo4j database to extract the local graph topology. You **must** provide the Neo4j credentials via environment variables.

Create a `.env` file in this directory or export the following variables in your shell before starting the service:

```bash
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=your_actual_password  # Required! The service will fail to boot without this.
```

## Running the Service

Start the FastAPI server:

```bash
python app.py
```

The service will be available at `http://localhost:8000`.

## Integration with Node.js Backend

The Node.js backend contains a worker (`backend/src/workers/gnnSync.worker.js`) that is capable of calling this service at `POST /predict/otc-risk` to write the `SUSPECTED_OTC_BROKER` tag directly into Neo4j.
