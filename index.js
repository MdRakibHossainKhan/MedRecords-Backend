require("dotenv").config();
const express = require("express");
const AWS = require("aws-sdk");
const multer = require("multer");
const cors = require("cors");
const { promisify } = require("util");
const FormData = require("form-data");
const axios = require("axios");
const fs = require("fs");
const app = express();
const port = process.env.PORT || 5000;

// Enable CORS and JSON parsing
app.use(cors());
app.use(express.json());

// Set up file uploads temporarily on disk
const upload = multer({ dest: "uploads/" });

// AWS Configuration
const awsConfig = {
    region: process.env.AWS_REGION || "us-east-1",
};
if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    awsConfig.accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    awsConfig.secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
}
AWS.config.update(awsConfig);

function getAwsConfig(req) {
    const isDoctor = req.headers["x-role"] === "doctor";

    return {
        region: process.env.AWS_REGION || "us-east-1",
        accessKeyId: isDoctor
            ? process.env.AWS_ACCESS_KEY_ID_DOCTOR
            : process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: isDoctor
            ? process.env.AWS_SECRET_ACCESS_KEY_DOCTOR
            : process.env.AWS_SECRET_ACCESS_KEY,
    };
}

// DynamoDB & S3 setup
const dynamoDB = new AWS.DynamoDB.DocumentClient();
const TABLE_NAME = process.env.DYNAMODB_TABLE_NAME || "MedicalRecords";
const s3 = new AWS.S3();

// ==========
// Middleware to get userSub
// ==========
function mockAuth(req, res, next) {
    req.user = { sub: req.headers["x-sub"] || "demo-sub" };
    next();
}
app.use(mockAuth);

// ==========
// Health Check
// ==========
app.get("/", (req, res) => {
    res.json({ message: "Node.js Backend is Running! 🚀" });
});

// ==========
// Get Profile
// ==========
app.get("/profile", async (req, res) => {
    const userSub = req.user.sub;
    const params = {
        TableName: TABLE_NAME,
        Key: { PatientID: userSub, RecordID: "PROFILE" },
    };

    try {
        const data = await dynamoDB.get(params).promise();
        if (!data.Item) return res.status(404).json({ error: "Profile not found." });
        res.json(data.Item);
    } catch (error) {
        res.status(500).json({ error: "Error fetching profile", details: error.message });
    }
});

// ==========
// Get All Medical Records
// ==========
app.get("/records", async (req, res) => {
    const userSub = req.user.sub;
    const params = {
        TableName: TABLE_NAME,
        KeyConditionExpression: "PatientID = :sub AND begins_with(RecordID, :rec)",
        ExpressionAttributeValues: { ":sub": userSub, ":rec": "REC#" },
    };

    try {
        const data = await dynamoDB.query(params).promise();
        res.json(data.Items || []);
    } catch (error) {
        res.status(500).json({ error: "Error fetching records", details: error.message });
    }
});

// ==========
// Get a Single Record
// ==========
app.get("/records/:recordID", async (req, res) => {
    const userSub = req.user.sub;
    const { recordID } = req.params;
    const params = {
        TableName: TABLE_NAME,
        Key: { PatientID: userSub, RecordID: recordID },
    };

    try {
        const data = await dynamoDB.get(params).promise();
        if (!data.Item) return res.status(404).json({ error: "Record not found." });
        res.json(data.Item);
    } catch (error) {
        res.status(500).json({ error: "Error fetching record", details: error.message });
    }
});

// ==========
// Create a New Record
// ==========
app.post("/records", async (req, res) => {
    const userSub = req.user.sub;
    const { recordID, Diagnosis, Date } = req.body;

    if (!recordID || !Diagnosis || !Date) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    const params = {
        TableName: TABLE_NAME,
        Item: { PatientID: userSub, RecordID: recordID, Diagnosis, Date },
        ConditionExpression: "attribute_not_exists(PatientID) AND attribute_not_exists(RecordID)",
    };

    try {
        await dynamoDB.put(params).promise();
        res.json({ message: "Medical record created successfully!", data: params.Item });
    } catch (error) {
        res.status(500).json({ error: "Error creating record", details: error.message });
    }
});

// ==========
// Upload X-ray to S3
// ==========
app.post("/upload-xray", upload.single("xray"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const timestamp = Date.now();
    const filename = `${timestamp}-${req.file.originalname}`;
    const params = {
        Bucket: process.env.S3_BUCKET_NAME,
        Key: filename,
        Body: req.file.buffer, // Note: This uses memory buffering if configured
        ContentType: req.file.mimetype,
    };

    try {
        const uploadResult = await s3.upload(params).promise();
        res.json({ message: "X-Ray uploaded successfully!", url: uploadResult.Location, fileName: filename, timestamp: timestamp });
    } catch (error) {
        res.status(500).json({ error: "Upload failed", details: error.message });
    }
});

// ==========
// Delete a Record
// ==========
app.delete("/records/:recordID", async (req, res) => {
    const userSub = req.user.sub;
    const { recordID } = req.params;
    const params = { TableName: TABLE_NAME, Key: { PatientID: userSub, RecordID: recordID } };

    try {
        await dynamoDB.delete(params).promise();
        res.json({ message: "Medical record deleted successfully" });
    } catch (error) {
        res.status(500).json({ error: "Error deleting record", details: error.message });
    }
});

// ==========
// Get Active Prescriptions
// ==========
app.get("/prescriptions", async (req, res) => {
    const userSub = req.user.sub;
    const params = {
        TableName: TABLE_NAME,
        KeyConditionExpression: "PatientID = :sub AND begins_with(RecordID, :pre)",
        ExpressionAttributeValues: { ":sub": userSub, ":pre": "PRE#" },
    };

    try {
        const data = await dynamoDB.query(params).promise();
        res.json(data.Items || []);
    } catch (error) {
        res.status(500).json({ error: "Error fetching prescriptions", details: error.message });
    }
});

// ==========
// Store X-Ray Prediction in DynamoDB
// ==========
app.post("/analyze-xray", upload.single("file"), async (req, res) => {
    const file = req.file;
    const userSub = req.headers["x-sub"];

    if (!file) return res.status(400).json({ error: "No file uploaded" });

    try {
        const formData = new FormData();
        formData.append("file", fs.createReadStream(file.path), file.originalname);

        const classifierResponse = await axios.post(
            "http://medportal-lb-1742379571.us-east-2.elb.amazonaws.com:8000/classifier/predict",
            formData,
            { headers: formData.getHeaders() }
        );

        const prediction = classifierResponse.data.prediction;
        const now = new Date();
        const pad = (num) => String(num).padStart(2, '0');
        const formattedTimestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
        const recordID = `XRAY#${formattedTimestamp}`;

        const params = {
            TableName: TABLE_NAME,
            Item: { PatientID: userSub, RecordID: recordID, Prediction: prediction, FileName: file.originalname, Timestamp: formattedTimestamp },
        };

        await dynamoDB.put(params).promise();
        res.json({ prediction, formattedTimestamp });

    } catch (error) {
        res.status(500).json({ error: "Failed to analyze the X-ray", details: error.message });
    } finally {
        const unlinkAsync = promisify(fs.unlink);
        await unlinkAsync(file.path);
    }
});

// ====================
// Doctor Routes Middleware
// ====================
function requireDoctor(req, res, next) {
    if (req.headers["x-role"] === "doctor") {
        req.user.role = "doctor";
        return next();
    }
    return res.status(403).json({ error: "Access denied: Doctor role required" });
}

// ====================
// Get Aggregated Patient Data (Doctor Dashboard)
// ====================
app.get("/all-aggregated", requireDoctor, async (req, res) => {
    const params = { TableName: TABLE_NAME };

    try {
        const data = await dynamoDB.scan(params).promise();
        const items = data.Items || [];
        const aggregated = {};

        items.forEach((item) => {
            const pid = item.PatientID;
            if (item.RecordID === "PROFILE" && (!item.Username || item.Username === "N/A")) return;

            if (!aggregated[pid]) {
                aggregated[pid] = { PatientID: pid, profile: null, activePrescriptions: [], recentRecords: [], xrayRecords: [] };
            }

            if (item.RecordID === "PROFILE") aggregated[pid].profile = item;
            else if (item.RecordID.startsWith("PRE#")) aggregated[pid].activePrescriptions.push(item);
            else if (item.RecordID.startsWith("REC#")) aggregated[pid].recentRecords.push(item);
            else if (item.RecordID.startsWith("XRAY#")) aggregated[pid].xrayRecords.push(item);
        });

        const result = Object.values(aggregated).filter((patient) => patient.profile !== null);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: "Error aggregating data", details: error.message });
    }
});

// ====================
// Doctor Management Routes 
// ====================
app.post("/add-patient", requireDoctor, async (req, res) => {
    const { PatientID, name, age, bloodType, weight } = req.body;
    if (!PatientID || !name || !age || !bloodType || !weight) return res.status(400).json({ error: "Missing fields" });

    const paramsCheck = { TableName: TABLE_NAME, Key: { PatientID, RecordID: "PROFILE" } };

    try {
        const existing = await dynamoDB.get(paramsCheck).promise();
        if (existing.Item) return res.status(409).json({ error: "Patient already exists" });

        const paramsPut = { TableName: TABLE_NAME, Item: { PatientID, RecordID: "PROFILE", name, age, bloodType, weight } };
        await dynamoDB.put(paramsPut).promise();
        res.json({ message: "Patient added successfully", patient: paramsPut.Item });
    } catch (error) {
        res.status(500).json({ error: "Error adding patient", details: error.message });
    }
});

app.put("/update-patient", requireDoctor, async (req, res) => {
    const { PatientID, FullName, Age, BloodType, Weight, Username, activePrescriptions, recentRecords, xrayRecords } = req.body;

    if (!PatientID || !FullName || !Age || !BloodType || !Weight || !Username) return res.status(400).json({ error: "Missing fields" });

    const item = {
        PatientID, RecordID: "PROFILE", FullName, Age, BloodType, Weight, Username,
        activePrescriptions: Array.isArray(activePrescriptions) ? activePrescriptions : [],
        recentRecords: Array.isArray(recentRecords) ? recentRecords : [],
        xrayRecords: Array.isArray(xrayRecords) ? xrayRecords : []
    };

    const params = { TableName: TABLE_NAME, Item: item };

    try {
        await dynamoDB.put(params).promise();
        res.json({ message: "Patient updated successfully", patient: item });
    } catch (error) {
        res.status(500).json({ error: "Error updating patient", details: error.message });
    }
});

app.delete("/delete-patient/:PatientID", requireDoctor, async (req, res) => {
    const { PatientID } = req.params;
    const params = { TableName: TABLE_NAME, Key: { PatientID, RecordID: "PROFILE" } };

    try {
        await dynamoDB.delete(params).promise();
        res.json({ message: "Patient profile deleted successfully" });
    } catch (error) {
        res.status(500).json({ error: "Error deleting patient", details: error.message });
    }
});

app.post("/add-prescription", requireDoctor, async (req, res) => {
    const { PatientID, Name, Dosage } = req.body;
    if (!PatientID || !Name || !Dosage) return res.status(400).json({ error: "Missing fields" });

    const timestamp = Date.now();
    const params = { TableName: TABLE_NAME, Item: { PatientID, RecordID: `PRE#${timestamp}`, Name, Dosage, Timestamp: timestamp } };

    try {
        await dynamoDB.put(params).promise();
        res.json({ message: "Prescription added successfully", prescription: params.Item });
    } catch (error) {
        res.status(500).json({ error: "Error adding prescription", details: error.message });
    }
});

app.post("/add-record", requireDoctor, async (req, res) => {
    const { PatientID, Diagnosis, Date } = req.body;
    if (!PatientID || !Diagnosis || !Date) return res.status(400).json({ error: "Missing fields" });

    const params = { TableName: TABLE_NAME, Item: { PatientID, RecordID: `REC#${Date}`, Diagnosis, Date } };

    try {
        await dynamoDB.put(params).promise();
        res.json({ message: "Record added successfully", record: params.Item });
    } catch (error) {
        res.status(500).json({ error: "Error adding record", details: error.message });
    }
});

app.delete("/delete-item/:recordID", requireDoctor, async (req, res) => {
    const { recordID } = req.params;
    const patientID = req.query["x-patient-id"];
    if (!patientID) return res.status(400).json({ error: "Missing patient ID" });

    const params = { TableName: TABLE_NAME, Key: { PatientID: patientID, RecordID: recordID } };

    try {
        await dynamoDB.delete(params).promise();
        res.json({ message: `Item ${recordID} deleted successfully` });
    } catch (error) {
        res.status(500).json({ error: "Failed to delete item", details: error.message });
    }
});

// ====================
// Patient Creation via Cognito (Doctor access)
// ====================
app.post("/create-patient", requireDoctor, async (req, res) => {
    const { FullName, Age, BloodType, Weight, Email, Username } = req.body;

    if (!FullName || !Age || !BloodType || !Weight || !Email || !Username) return res.status(400).json({ error: "Missing fields" });

    try {
        const doctorAwsConfig = getAwsConfig(req);
        const cognito = new AWS.CognitoIdentityServiceProvider(doctorAwsConfig);
        const dynamoDbDoctor = new AWS.DynamoDB.DocumentClient(doctorAwsConfig);

        const createUserParams = {
            UserPoolId: process.env.COGNITO_USER_POOL_ID,
            Username: Username,
            UserAttributes: [{ Name: "email", Value: Email }, { Name: "name", Value: FullName }],
            TemporaryPassword: "TempPass123!",
        };

        const cognitoResponse = await cognito.adminCreateUser(createUserParams).promise();
        const patientSub = cognitoResponse.User.Attributes.find(attr => attr.Name === "sub").Value;

        const dbParams = {
            TableName: TABLE_NAME,
            Item: { PatientID: patientSub, RecordID: "PROFILE", FullName, Age, BloodType, Weight, Username, Email, activePrescriptions: [], recentRecords: [], xrayRecords: [] },
        };

        await dynamoDbDoctor.put(dbParams).promise();
        res.json({ message: "Patient created successfully", patient: dbParams.Item, cognitoUser: cognitoResponse.User });
    } catch (error) {
        res.status(500).json({ error: "Error creating patient", details: error.message });
    }
});

app.get("/search-patient", requireDoctor, async (req, res) => {
    const { username } = req.query;
    if (!username) return res.status(400).json({ error: "Missing 'username'" });

    const params = {
        TableName: TABLE_NAME,
        IndexName: "Username-index",
        KeyConditionExpression: "Username = :username",
        ExpressionAttributeValues: { ":username": username },
    };

    try {
        const result = await dynamoDB.query(params).promise();
        if (!result.Items || result.Items.length === 0) return res.status(404).json({ error: "Patient not found" });
        res.json(result.Items);
    } catch (error) {
        res.status(500).json({ error: "Error searching patient", details: error.message });
    }
});

// Start Server
const server = app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});

// Catch sneaky background errors
server.on("error", (error) => {
    console.error("Server crashed with error:", error);
});