const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand } = require("@aws-sdk/lib-dynamodb");
const crypto = require("crypto");
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

// standard cors setup
app.use(cors({
    origin: ["http://localhost:5173", "http://127.0.0.1:5173"], 
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-role", "x-sub", "x-patient-id"]
}));

// parse json body
app.use(express.json());

// changed from 5000 to 8080 to avoid mac airplay collision
const port = process.env.PORT || 8080;

// setup temp file upload
const upload = multer({ dest: "uploads/" });

// aws config
const TABLE_NAME = process.env.DYNAMODB_TABLE_NAME || "MedicalRecords";

// sdk v3 setup
const v3Client = new DynamoDBClient({ region: process.env.AWS_REGION || "us-east-1" });
const docClient = DynamoDBDocumentClient.from(v3Client);

// sdk v2 setup
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

// get aws config based on role
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

// strict mock auth middleware
function mockAuth(req, res, next) {
    req.user = { sub: req.headers["x-sub"] || "demo-sub" };
    next();
}
app.use(mockAuth);

// health check
app.get("/", (req, res) => {
    res.json({ message: "Node.js Backend is Running! 🚀" });
});

// add patient via dashboard
app.post("/api/patients", async (req, res) => {
    try {
        const { name, age, condition } = req.body;

        // gen unique id
        const patientId = crypto.randomUUID();

        // format data schema
        const newPatient = {
            PatientID: patientId,
            RecordID: "PROFILE",
            FullName: name,
            Age: age,
            PrimaryCondition: condition,
            CreatedAt: new Date().toISOString(),
            activePrescriptions: [],
            recentRecords: [],
            xrayRecords: []
        };

        // init put command
        const command = new PutCommand({
            TableName: TABLE_NAME,
            Item: newPatient,
        });

        // send to db
        await docClient.send(command);

        console.log("SUCCESS! Patient saved:", newPatient);
        res.status(201).json({ message: "Patient saved!", patient: newPatient });

    } catch (error) {
        console.error("Error saving patient:", error);
        res.status(500).json({ error: "Failed to save patient" });
    }
});

// get profile
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

// get all records
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

// get single record
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

// create new record
app.post("/records", async (req, res) => {
    const userSub = req.user.sub;
    const { recordID, Diagnosis, Date } = req.body;

    if (!recordID || !Diagnosis || !Date) {
        return res.status(400).json({ error: "Missing fields" });
    }

    const params = {
        TableName: TABLE_NAME,
        Item: { PatientID: userSub, RecordID: recordID, Diagnosis, Date },
        ConditionExpression: "attribute_not_exists(PatientID) AND attribute_not_exists(RecordID)",
    };

    try {
        await dynamoDB.put(params).promise();
        res.json({ message: "Record created!", data: params.Item });
    } catch (error) {
        res.status(500).json({ error: "Error creating record", details: error.message });
    }
});

// upload xray to s3
app.post("/upload-xray", upload.single("xray"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

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
        
        // clean temp file
        const unlinkAsync = promisify(fs.unlink);
        await unlinkAsync(req.file.path);
        
        res.json({ message: "X-Ray uploaded!", url: uploadResult.Location, fileName: filename, timestamp: timestamp });
    } catch (error) {
        res.status(500).json({ error: "Upload failed", details: error.message });
    }
});

// delete record
app.delete("/records/:recordID", async (req, res) => {
    const userSub = req.user.sub;
    const { recordID } = req.params;
    const params = { TableName: TABLE_NAME, Key: { PatientID: userSub, RecordID: recordID } };

    try {
        await dynamoDB.delete(params).promise();
        res.json({ message: "Record deleted" });
    } catch (error) {
        res.status(500).json({ error: "Error deleting record", details: error.message });
    }
});

// get active prescriptions
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

// store xray prediction
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
        res.status(500).json({ error: "Failed to analyze X-ray", details: error.message });
    } finally {
        // cleanup
        const unlinkAsync = promisify(fs.unlink);
        if (file && file.path) await unlinkAsync(file.path);
    }
});

// strict require doctor role middleware
function requireDoctor(req, res, next) {
    if (req.headers["x-role"] === "doctor") {
        req.user.role = "doctor";
        return next();
    }
    return res.status(403).json({ error: "Access denied" });
}

// get aggregated patient data
app.get("/all-aggregated", requireDoctor, async (req, res) => {
    const params = { TableName: TABLE_NAME };

    try {
        const data = await dynamoDB.scan(params).promise();
        const items = data.Items || [];
        const aggregated = {};

        items.forEach((item) => {
            const pid = item.PatientID;

            // init scaffold if missing
            if (!aggregated[pid]) {
                aggregated[pid] = { PatientID: pid, profile: null, activePrescriptions: [], recentRecords: [], xrayRecords: [] };
            }

            // map records
            if (item.RecordID === "PROFILE") aggregated[pid].profile = item;
            else if (item.RecordID.startsWith("PRE#")) aggregated[pid].activePrescriptions.push(item);
            else if (item.RecordID.startsWith("REC#")) aggregated[pid].recentRecords.push(item);
            else if (item.RecordID.startsWith("XRAY#")) aggregated[pid].xrayRecords.push(item);
        });

        // filter valid profiles
        const result = Object.values(aggregated).filter((patient) => patient.profile !== null);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: "Error aggregating data", details: error.message });
    }
});

// add patient doctor route
app.post("/add-patient", requireDoctor, async (req, res) => {
    const { PatientID, name, age, bloodType, weight } = req.body;
    if (!PatientID || !name || !age || !bloodType || !weight) return res.status(400).json({ error: "Missing fields" });

    const paramsCheck = { TableName: TABLE_NAME, Key: { PatientID, RecordID: "PROFILE" } };

    try {
        const existing = await dynamoDB.get(paramsCheck).promise();
        if (existing.Item) return res.status(409).json({ error: "Patient exists" });

        const paramsPut = { TableName: TABLE_NAME, Item: { PatientID, RecordID: "PROFILE", name, age, bloodType, weight } };
        await dynamoDB.put(paramsPut).promise();
        res.json({ message: "Patient added", patient: paramsPut.Item });
    } catch (error) {
        res.status(500).json({ error: "Error adding patient", details: error.message });
    }
});

// update patient doctor route
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
        res.json({ message: "Patient updated", patient: item });
    } catch (error) {
        res.status(500).json({ error: "Error updating patient", details: error.message });
    }
});

// delete patient doctor route
app.delete("/delete-patient/:PatientID", requireDoctor, async (req, res) => {
    const { PatientID } = req.params;
    const params = { TableName: TABLE_NAME, Key: { PatientID, RecordID: "PROFILE" } };

    try {
        await dynamoDB.delete(params).promise();
        res.json({ message: "Patient deleted" });
    } catch (error) {
        res.status(500).json({ error: "Error deleting patient", details: error.message });
    }
});

// add prescription doctor route
app.post("/add-prescription", requireDoctor, async (req, res) => {
    const { PatientID, Name, Dosage } = req.body;
    if (!PatientID || !Name || !Dosage) return res.status(400).json({ error: "Missing fields" });

    const timestamp = Date.now();
    const params = { TableName: TABLE_NAME, Item: { PatientID, RecordID: `PRE#${timestamp}`, Name, Dosage, Timestamp: timestamp } };

    try {
        await dynamoDB.put(params).promise();
        res.json({ message: "Prescription added", prescription: params.Item });
    } catch (error) {
        res.status(500).json({ error: "Error adding prescription", details: error.message });
    }
});

// add record doctor route
app.post("/add-record", requireDoctor, async (req, res) => {
    const { PatientID, Diagnosis, Date } = req.body;
    if (!PatientID || !Diagnosis || !Date) return res.status(400).json({ error: "Missing fields" });

    const params = { TableName: TABLE_NAME, Item: { PatientID, RecordID: `REC#${Date}`, Diagnosis, Date } };

    try {
        await dynamoDB.put(params).promise();
        res.json({ message: "Record added", record: params.Item });
    } catch (error) {
        res.status(500).json({ error: "Error adding record", details: error.message });
    }
});

// delete item doctor route
app.delete("/delete-item/:recordID", requireDoctor, async (req, res) => {
    const { recordID } = req.params;
    const patientID = req.query["x-patient-id"];
    if (!patientID) return res.status(400).json({ error: "Missing ID" });

    const params = { TableName: TABLE_NAME, Key: { PatientID: patientID, RecordID: recordID } };

    try {
        await dynamoDB.delete(params).promise();
        res.json({ message: `Item deleted` });
    } catch (error) {
        res.status(500).json({ error: "Failed to delete item", details: error.message });
    }
});

// create patient via cognito doctor route
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
        res.json({ message: "Patient created", patient: dbParams.Item, cognitoUser: cognitoResponse.User });
    } catch (error) {
        res.status(500).json({ error: "Error creating patient", details: error.message });
    }
});

// search patient doctor route
app.get("/search-patient", requireDoctor, async (req, res) => {
    const { username } = req.query;
    if (!username) return res.status(400).json({ error: "Missing username" });

    const params = {
        TableName: TABLE_NAME,
        IndexName: "Username-index",
        KeyConditionExpression: "Username = :username",
        ExpressionAttributeValues: { ":username": username },
    };

    try {
        const result = await dynamoDB.query(params).promise();
        if (!result.Items || result.Items.length === 0) return res.status(404).json({ error: "Not found" });
        res.json(result.Items);
    } catch (error) {
        res.status(500).json({ error: "Error searching patient", details: error.message });
    }
});

// start server
const server = app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});

// handle crash
server.on("error", (error) => {
    console.error("Server crashed:", error);
});