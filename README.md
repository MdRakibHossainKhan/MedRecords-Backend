# MedRecords: A Privacy-First, Decentralized Cloud Medical Records System Utilizing Federated Learning

**Institution:** University of New Brunswick
**Course:** CS6905 - Cloud Information Management Systems

## Project Overview
MedRecords is a secure, cloud-native web application designed to streamline patient registry management for healthcare providers. The system provides a seamless interface for providers to perform full CRUD operations on patient profiles, track active prescriptions, maintain medical histories, and process radiology scans using a diagnostic analysis pipeline.

The architecture leverages a decoupled frontend and backend, integrating with Amazon Web Services (AWS) for secure authentication and highly scalable NoSQL data storage.

## Architecture & Technologies
This project implements a modern JavaScript full-stack architecture:

**Frontend:** React.js, Vite, Tailwind CSS, React Router
**Backend:** Node.js, Express.js, Multer
**Database:** AWS DynamoDB (Serverless NoSQL)
**Authentication:** AWS Cognito
**Cloud Infrastructure:** AWS SDK (v2 & v3)

---

## Local Setup Instructions

To run this application locally, we will need two separate terminal windows one for the backend API and one for the frontend client.

### Prerequisites
**Node.js:** v18.0.0 or higher
**AWS Credentials:** Active IAM credentials with `AmazonDynamoDBFullAccess` and `AmazonCognitoPowerUser` permissions.

### 1. Backend Setup (Node.js/Express)
1. Open a terminal and navigate to the backend directory:
   ```bash
   cd backend
   ```
2. Install the required Node dependencies:
   ```bash
   npm install express cors dotenv aws-sdk @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb multer
   ```
3. Create a `.env` file in the root of the backend directory and configure environment variables:
   ```env
   PORT=8080
   AWS_REGION=us-east-1
   AWS_ACCESS_KEY_ID=access_key_here
   AWS_SECRET_ACCESS_KEY=secret_key_here
   DYNAMODB_TABLE_NAME=MedicalRecords
   COGNITO_USER_POOL_ID=pool_id_here
   S3_BUCKET_NAME=s3_bucket_name
   ```
4. Start the backend server:
   ```bash
   node index.js
   ```
   *The server will run on `http://localhost:8080`.*

### 2. Frontend Setup (React/Vite)
1. Open a second terminal and navigate to the frontend directory:
   ```bash
   cd frontend
   ```
2. Install the required React dependencies:
   ```bash
   npm install react react-dom react-router-dom amazon-cognito-identity-js axios
   npm install -D @tailwindcss/vite tailwindcss
   ```
3. Start the Vite development server:
   ```bash
   npm run dev
   ```
4. Open your web browser and navigate to the local URL provided by Vite (typically `http://localhost:5173`).

---

## Key Features & Functionality

**Secure Provider Access:** Provider login authenticated securely via AWS Cognito.
**Patient Registry Dashboard:** Real-time aggregation of patient data pulled directly from AWS DynamoDB.
**Full CRUD Operations:**
**Create:** Add new patients with detailed demographics (Age, Blood Type, Weight, Primary Condition).
**Read:** View aggregated medical files including recent records and active prescriptions.
**Update:** Inline editing of patient demographic profiles.
**Delete:** Secure removal of patient records from the cloud database.
**Radiology Processing Pipeline:** Ability to upload X-Ray scans and receive automated diagnostic predictions.

## Security Implementation
**Role-Based Access Control (RBAC):** Backend routes are protected by custom middleware (`requireDoctor`) that validates authorization headers before executing database commands.
**NoSQL Injection Prevention:** Database queries utilize parameterized `ExpressionAttributeValues` via the AWS SDK to prevent injection attacks.
**CORS Policies:** Cross-Origin Resource Sharing is strictly configured to only accept requests from the designated local Vite environment.