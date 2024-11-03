import express from 'express';
import cors from 'cors';
import Mailjet from 'node-mailjet';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import multer from 'multer';
import { exec } from 'child_process';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import { fileURLToPath } from 'url';


dotenv.config();
uuidv4();
const app = express();
const PORT = process.env.PORT || 5000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const mailjet = new Mailjet({
    apiKey: process.env.MJ_APIKEY_PUBLIC || 'your-api-key',
    apiSecret: process.env.MJ_APIKEY_PRIVATE || 'your-api-secret'
});

// console.log(process.env.MJ_APIKEY_PUBLIC,)

// Set up storage for uploaded files
const storage = multer.diskStorage({
destination: (req, file, cb) => {
cb(null, 'uploads/');
},
filename: (req, file, cb) => {
cb(null, Date.now() + '-' + file.originalname);
}
});

// Create the multer instance
const upload = multer({ storage: storage });

app.use(cors());
app.use(bodyParser.json());
app.use("/public", express.static(path.join(__dirname, "public")));

app.post('/send-email', (req, res) => {
    const { emailForm } = req.body;
    const { email, username, message } = emailForm;
    console.log(email, username, message)


    //need to change the domain to ensure email does not end up in the spam folder
    const request = mailjet
        .post('send', { version: 'v3.1' })
        .request({
          Messages: [
            {
              From: {
                Email: email,
                Name: username,
              },
              To: [
                {
                  Email: "mandlankosi739@gmail.com",
                  Name: "Mandlenkosi First Touch"
                }
              ],
              Subject: "First Touch Contact",
              TextPart: message,
            }
          ]
        })

    request
        .then((result) => {
            console.log(result.body)
            res.status(200).send('Email Sent')
        })
        .catch((err) => {
            console.log(err.statusCode)
        })
})

//convert mp4 to hls format
const chapters = {} // We will create an in-memory DB for now

app.post('/upload', upload.single('video'), (req, res) => {
    const chapterId = uuidv4(); // Generate a unique chapter ID
    const videoPath = req.file.path;
    const outputDir = `public/videos/${chapterId}`;
    const outputFileName = 'output.m3u8';
    const outputPath = path.join(outputDir, outputFileName);

    // Check if output directory exists, create if not
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    // Command to convert video to HLS format using ffmpeg
    const command = `ffmpeg -i ${videoPath} \
        -map 0:v -c:v libx264 -crf 23 -preset medium -g 48 \
        -map 0:v -c:v libx264 -crf 28 -preset fast -g 48 \
        -map 0:v -c:v libx264 -crf 32 -preset fast -g 48 \
        -map 0:a -c:a aac -b:a 128k \
        -hls_time 10 -hls_playlist_type vod -hls_flags independent_segments -report \
        -f hls ${outputPath}`;

    // Execute ffmpeg command
    exec(command, (error, stdout, stderr) => {
        if (error) {
            console.error(`ffmpeg exec error: ${error}`);
            return res.status(500).json({ error: 'Failed to convert video to HLS format' });
        }
        console.log(`stdout: ${stdout}`);
        console.error(`stderr: ${stderr}`);
        const videoUrl = `public/videos/${chapterId}/${outputFileName}`;
        chapters[chapterId] = { videoUrl, title: req.body.title, description: req.body.description }; // Store chapter information
        res.json({ success: true, message: 'Video uploaded and converted to HLS.', chapterId });
    });
});

//get the hls format video
app.get('/getVideo', (req, res) => {
  const { chapterId } = req.query;
  if (!chapterId || !chapters[chapterId]) {
      return res.status(404).json({ error: 'Chapter not found' });
  }
  const { title, videoUrl } = chapters[chapterId];
  console.log(title, " ", videoUrl)
  res.json({ title: title, url: videoUrl });
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});