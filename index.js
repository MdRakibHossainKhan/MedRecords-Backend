const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand } = require("@aws-sdk/lib-dynamodb");
const crypto = require("crypto");
require("dotenv").config();
const express = require("express");
const AWS = require("aws-sdk");
const multer = require("multer");
const cors = require("cors");
const { promisify } = require("util");
const fs = require("fs");

const app = express();

app.use(cors({
    origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-role", "x-sub", "x-patient-id"]
}));

app.use(express.json());

const port = process.env.PORT || 8080;

if (!fs.existsSync("uploads/")) {
    fs.mkdirSync("uploads/");
}
const upload = multer({ dest: "uploads/" });

const TABLE_NAME = process.env.DYNAMODB_TABLE_NAME || "MedicalRecords";

const v3Client = new DynamoDBClient({ region: process.env.AWS_REGION || "us-east-1" });
const docClient = DynamoDBDocumentClient.from(v3Client);

const awsConfig = {
    region: process.env.AWS_REGION || "us-east-1",
};

if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    awsConfig.accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    awsConfig.secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
}

AWS.config.update(awsConfig);
const dynamoDB = new AWS.DynamoDB.DocumentClient();
const s3 = new AWS.S3();

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

// Authentication Middleware
function authenticateRequest(req, res, next) {
    req.user = { sub: req.headers["x-sub"] || "auth-user-1" };
    next();
}

function requireDoctor(req, res, next) {
    if (req.headers["x-role"] === "doctor") {
        req.user.role = "doctor";
        return next();
    }
    return res.status(403).json({ error: "Access denied" });
}

app.use(authenticateRequest);

app.get("/", (req, res) => {
    res.json({ message: "API is active" });
});

app.post("/api/patients", async (req, res) => {
    try {
        const { name, age, condition, bloodType, weight } = req.body;
        const patientId = crypto.randomUUID();

        const newPatient = {
            PatientID: patientId,
            RecordID: "PROFILE",
            FullName: name,
            Age: age,
            PrimaryCondition: condition,
            BloodType: bloodType || "N/A",
            Weight: weight || "N/A",
            CreatedAt: new Date().toISOString()
        };

        const command = new PutCommand({ TableName: TABLE_NAME, Item: newPatient });
        await docClient.send(command);

        res.status(201).json({ message: "Patient record created", patient: newPatient });
    } catch (error) {
        console.error("Database Error:", error);
        res.status(500).json({ error: "Failed to create record" });
    }
});

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
        res.status(500).json({ error: "Data retrieval error", details: error.message });
    }
});

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
        res.status(500).json({ error: "Data retrieval error", details: error.message });
    }
});

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
        res.status(500).json({ error: "Data retrieval error", details: error.message });
    }
});

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
        res.json({ message: "Record created successfully", data: params.Item });
    } catch (error) {
        res.status(500).json({ error: "Failed to create record", details: error.message });
    }
});

app.post("/upload-xray", upload.single("xray"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file provided" });

    const timestamp = Date.now();
    const filename = `${timestamp}-${req.file.originalname}`;

    const params = {
        Bucket: process.env.S3_BUCKET_NAME,
        Key: filename,
        Body: fs.createReadStream(req.file.path),
        ContentType: req.file.mimetype,
    };

    try {
        const uploadResult = await s3.upload(params).promise();
        const unlinkAsync = promisify(fs.unlink);
        await unlinkAsync(req.file.path);

        res.json({ message: "Upload successful", url: uploadResult.Location, fileName: filename, timestamp: timestamp });
    } catch (error) {
        res.status(500).json({ error: "Upload failed", details: error.message });
    }
});

app.delete("/records/:recordID", async (req, res) => {
    const userSub = req.user.sub;
    const { recordID } = req.params;
    const params = { TableName: TABLE_NAME, Key: { PatientID: userSub, RecordID: recordID } };

    try {
        await dynamoDB.delete(params).promise();
        res.json({ message: "Record removed successfully" });
    } catch (error) {
        res.status(500).json({ error: "Failed to remove record", details: error.message });
    }
});

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
        res.status(500).json({ error: "Data retrieval error", details: error.message });
    }
});

app.post("/analyze-xray", async (req, res) => {
    const userSub = req.headers["x-sub"] || "auth-user-1";
    const fileName = req.body.fileName || "unknown-file.jpg";

    try {
        const diagnosticOutcomes = [
            "Negative (Normal Lungs)",
            "Positive - Viral Pneumonia Detected",
            "Positive - Bacterial Pneumonia Detected",
            "Inconclusive - Requires Manual Review"
        ];

        const prediction = diagnosticOutcomes[Math.floor(Math.random() * diagnosticOutcomes.length)];

        const now = new Date();
        const pad = (num) => String(num).padStart(2, '0');
        const formattedTimestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
        const recordID = `XRAY#${formattedTimestamp}`;

        const params = {
            TableName: TABLE_NAME,
            Item: {
                PatientID: userSub,
                RecordID: recordID,
                Prediction: prediction,
                FileName: fileName,
                Timestamp: formattedTimestamp
            },
        };

        await dynamoDB.put(params).promise();
        res.json({ prediction, formattedTimestamp });

    } catch (error) {
        console.error("Processing Error:", error);
        res.status(500).json({ error: "Failed to process scan data", details: error.message });
    }
});

app.get("/all-aggregated", requireDoctor, async (req, res) => {
    const params = { TableName: TABLE_NAME };

    try {
        const data = await dynamoDB.scan(params).promise();
        const items = data.Items || [];
        const aggregated = {};

        items.forEach((item) => {
            const pid = item.PatientID;

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
        res.status(500).json({ error: "Data aggregation error", details: error.message });
    }
});

app.post("/add-patient", requireDoctor, async (req, res) => {
    const { PatientID, name, age, bloodType, weight } = req.body;
    if (!PatientID || !name || !age || !bloodType || !weight) return res.status(400).json({ error: "Missing required fields" });

    const paramsCheck = { TableName: TABLE_NAME, Key: { PatientID, RecordID: "PROFILE" } };

    try {
        const existing = await dynamoDB.get(paramsCheck).promise();
        if (existing.Item) return res.status(409).json({ error: "Record already exists" });

        const paramsPut = { TableName: TABLE_NAME, Item: { PatientID, RecordID: "PROFILE", name, age, bloodType, weight } };
        await dynamoDB.put(paramsPut).promise();
        res.json({ message: "Record added successfully", patient: paramsPut.Item });
    } catch (error) {
        res.status(500).json({ error: "Failed to process record", details: error.message });
    }
});

app.put("/update-patient", requireDoctor, async (req, res) => {
    const { PatientID, FullName, Age, BloodType, Weight, PrimaryCondition } = req.body;

    if (!PatientID || !FullName) return res.status(400).json({ error: "Missing identification parameters" });

    const item = {
        PatientID,
        RecordID: "PROFILE",
        FullName,
        Age,
        BloodType,
        Weight,
        PrimaryCondition
    };

    try {
        await dynamoDB.put({ TableName: TABLE_NAME, Item: item }).promise();
        res.json({ message: "Record updated successfully", patient: item });
    } catch (error) {
        res.status(500).json({ error: "Failed to update record", details: error.message });
    }
});

app.delete("/delete-patient/:PatientID", requireDoctor, async (req, res) => {
    const { PatientID } = req.params;
    const params = { TableName: TABLE_NAME, Key: { PatientID, RecordID: "PROFILE" } };

    try {
        await dynamoDB.delete(params).promise();
        res.json({ message: "Record removed successfully" });
    } catch (error) {
        res.status(500).json({ error: "Failed to remove record", details: error.message });
    }
});

app.post("/add-prescription", requireDoctor, async (req, res) => {
    const { PatientID, Name, Dosage } = req.body;
    if (!PatientID || !Name || !Dosage) return res.status(400).json({ error: "Missing required fields" });

    const timestamp = Date.now();
    const params = { TableName: TABLE_NAME, Item: { PatientID, RecordID: `PRE#${timestamp}`, Name, Dosage, Timestamp: timestamp } };

    try {
        await dynamoDB.put(params).promise();
        res.json({ message: "Prescription recorded", prescription: params.Item });
    } catch (error) {
        res.status(500).json({ error: "Failed to process prescription", details: error.message });
    }
});

app.post("/add-record", requireDoctor, async (req, res) => {
    const { PatientID, Diagnosis, Date } = req.body;
    if (!PatientID || !Diagnosis || !Date) return res.status(400).json({ error: "Missing required fields" });

    const params = { TableName: TABLE_NAME, Item: { PatientID, RecordID: `REC#${Date}`, Diagnosis, Date } };

    try {
        await dynamoDB.put(params).promise();
        res.json({ message: "Data logged successfully", record: params.Item });
    } catch (error) {
        res.status(500).json({ error: "Failed to process logging request", details: error.message });
    }
});

app.delete("/delete-item/:recordID", requireDoctor, async (req, res) => {
    const { recordID } = req.params;
    const patientID = req.query["x-patient-id"];
    if (!patientID) return res.status(400).json({ error: "Missing identification parameters" });

    const params = { TableName: TABLE_NAME, Key: { PatientID: patientID, RecordID: recordID } };

    try {
        await dynamoDB.delete(params).promise();
        res.json({ message: `Entry removed successfully` });
    } catch (error) {
        res.status(500).json({ error: "Failed to remove entry", details: error.message });
    }
});

app.post("/create-patient", requireDoctor, async (req, res) => {
    const { FullName, Age, BloodType, Weight, Email, Username } = req.body;

    if (!FullName || !Age || !BloodType || !Weight || !Email || !Username) return res.status(400).json({ error: "Missing required fields" });

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
        res.json({ message: "Registration complete", patient: dbParams.Item, cognitoUser: cognitoResponse.User });
    } catch (error) {
        res.status(500).json({ error: "Registration error", details: error.message });
    }
});

app.get("/search-patient", requireDoctor, async (req, res) => {
    const { username } = req.query;
    if (!username) return res.status(400).json({ error: "Missing required parameters" });

    const params = {
        TableName: TABLE_NAME,
        IndexName: "Username-index",
        KeyConditionExpression: "Username = :username",
        ExpressionAttributeValues: { ":username": username },
    };

    try {
        const result = await dynamoDB.query(params).promise();
        if (!result.Items || result.Items.length === 0) return res.status(404).json({ error: "Record not found" });
        res.json(result.Items);
    } catch (error) {
        res.status(500).json({ error: "Search query failed", details: error.message });
    }
});

const server = app.listen(port, () => {
    console.log(`System services initialized on port ${port}`);
});

server.on("error", (error) => {
    console.error("Critical service failure:", error);
});