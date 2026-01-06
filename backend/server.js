import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Fix for missing __dirname in ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 4000;
const DB_FILE = path.join(__dirname, 'appointments.json');

// Ensure DB file exists
if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify([]));
}

app.post('/log-appointment', (req, res) => {
    try {
        const newEntry = {
            id: Date.now(),
            timestamp: new Date().toISOString(),
            ...req.body
        };
        const fileContent = fs.readFileSync(DB_FILE, 'utf-8');
        const currentData = JSON.parse(fileContent || '[]');
        currentData.push(newEntry);
        fs.writeFileSync(DB_FILE, JSON.stringify(currentData, null, 2));
        
        console.log(`[SAVED] Appointment for ${newEntry.patientName}`);
        res.status(200).json({ success: true, id: newEntry.id });
    } catch (error) {
        console.error("Error:", error);
        res.status(500).json({ success: false });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});