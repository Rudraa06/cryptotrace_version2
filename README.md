# CryptoTrace Version 2

CryptoTrace is a full-stack blockchain forensics and OSINT platform designed for cyber-cell investigators to trace illicit cryptocurrency flows, identify money laundering patterns, and generate legally compliant (Section 65B) affidavits for use in court.

## 🚀 Features
*   **Real-time On-Chain Tracing:** Trace funds across multiple hops from victim wallets to suspected exchanges using the Alchemy RPC.
*   **Graph Analysis:** Visualize the flow of funds using dynamic D3 force-directed graphs.
*   **Advanced Risk Engine (GATv2):** A Python-based Graph Attention Network microservice analyzes transaction patterns to detect OTC brokers, Peel Chains, and Mixers (e.g. Tornado Cash).
*   **Sanctions Screening:** Automatic offline caching and screening against the US Treasury's OFAC SDN list.
*   **Role-Based Access Control:** Strict segregation of duties (Supervisors, Investigators, Analysts) with secure JWT sessions.
*   **Audit Logging:** Comprehensive, tamper-evident audit trails recording every query, ingest, and access event.
*   **Evidence Export:** One-click generation of PDF affidavits compliant with Section 65B of the Indian Evidence Act.
*   **Asynchronous Jobs:** Heavy traces are offloaded to BullMQ (Redis) to prevent server timeouts and ensure resilience.

---

## 🛠️ System Architecture & Tech Stack
*   **Frontend:** React 18, Vite, TailwindCSS, D3.js
*   **Backend:** Node.js (Express), BullMQ, JWT, pdfkit
*   **Databases:** Neo4j (Graph storage), Redis (Job queue & Cache)
*   **ML Service:** Python 3, FastAPI, PyTorch Geometric
*   **Blockchain Integration:** Alchemy SDK (EVM chains), Mempool.space (Bitcoin)

---

## 💻 Local Development Setup Guide

Follow these steps exactly to run the entire CryptoTrace stack locally on your machine.

### Prerequisites
Make sure you have the following installed on your system:
1.  **Node.js** (v20+ recommended)
2.  **Python** (3.10+ recommended)
3.  **Docker Desktop** (Required for Redis)
4.  **Neo4j Desktop** (or use the free cloud version at Neo4j Aura)

### 1. Database Setup
CryptoTrace requires Neo4j for storing the transaction graph and Redis for managing background trace jobs.

**A. Start Redis using Docker:**
Open your terminal (with Docker Desktop running) and run:
```bash
docker run -d -p 6379:6379 --name redis redis:alpine
```
*(This starts a lightweight Redis server on port 6379).*

**B. Start Neo4j:**
You can either run Neo4j locally using Neo4j Desktop (default URL is `bolt://localhost:7687`), or use a cloud AuraDB instance. Ensure you have the URI, username, and password ready.

### 2. Configure Environment Variables
You will need to set up `.env` files in both the frontend and backend directories.

**Backend (`backend/.env`):**
Create a `.env` file in the `backend/` directory using the provided `backend/.env.example` as a template. You must fill in:
*   `NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD`
*   `REDIS_URL` (If using local Docker, `redis://localhost:6379`)
*   `ALCHEMY_API_KEY` (Get a free key from alchemy.com)

**Frontend (`frontend/.env`):**
Create a `.env` file in the `frontend/` directory:
```env
VITE_API_URL=http://localhost:4000/api
```

### 3. Install Dependencies & Start Services
You will need to open **three separate terminal windows**, one for each service.

**Terminal 1: Node.js Backend**
```bash
cd backend
npm install
npm run dev
```
*(The backend runs on port 4000. Wait for "CryptoTrace backend listening" and "Neo4j connected" in the logs).*

**Terminal 2: Python ML Service**
```bash
cd ml-service
# It is highly recommended to use a virtual environment
python -m venv venv
venv\Scripts\activate   # On Windows
# source venv/bin/activate # On Mac/Linux

pip install -r requirements.txt
python app.py
```
*(The ML service runs on port 8000. It provides the GATv2 risk scores).*

**Terminal 3: React Frontend**
```bash
cd frontend
npm install
npm run dev
```
*(The frontend runs on port 5173. Open `http://localhost:5173` in your browser).*

---

## 🔒 Default Login Credentials
Once the system is running, access the dashboard at `http://localhost:5173`. 
If you seeded the database using the admin script, you can log in using:
*   **Email:** `admin@cybercell.gov.in`
*   **Password:** `CryptoTrace123!`

---

## ☁️ Deployment to Production (Free Tier)
To deploy this project to production for free, we recommend this distributed architecture to prevent running out of RAM on small instances:

1.  **Frontend:** Deploy the `frontend/` folder to **Vercel** or **Netlify**.
2.  **Backend & ML:** Deploy the `backend/` and `ml-service/` folders as separate Web Services on **Render.com**.
3.  **Databases:** 
    *   Graph DB: Use **Neo4j AuraDB Free**.
    *   Queue Cache: Use **Upstash Redis Free**.

*Be sure to add all the respective environment variables to the cloud provider dashboards during deployment.*
