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
import { Expo } from 'expo-server-sdk';
import { Client, Databases, Query } from 'node-appwrite';

dotenv.config();
uuidv4();

const app = express();
const PORT = process.env.PORT || 5000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


//utils
const storage = multer.diskStorage({
destination: (req, file, cb) => {
cb(null, 'uploads/');
},
filename: (req, file, cb) => {
cb(null, Date.now() + '-' + file.originalname);
}
});
const upload = multer({ storage: storage });


//SDK's
const appwriteClient = new Client();
appwriteClient
    .setEndpoint(process.env.EXPO_PUBLIC_ENDPOINT)
    .setProject(process.env.EXPO_PUBLIC_PROJECT_ID)
    .setKey(process.env.EXPO_API_ENDPOINT);

const databases = new Databases(appwriteClient);

const expoNotifications = new Expo({
  useFcmV1: true,
});

const mailjet = new Mailjet({
  apiKey: process.env.MJ_APIKEY_PUBLIC || 'your-api-key',
  apiSecret: process.env.MJ_APIKEY_PRIVATE || 'your-api-secret'
});

// Store push tokens for users (ideally in a database)
const pushTokens = ['ExponentPushToken[xxxxxxxxxx]',];


app.use(cors());
app.use(bodyParser.json());
app.use('/public', express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  return res.status(200).json({message: '...', 'errors': []})
})

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
                  Email: 'mandlankosi739@gmail.com',
                  Name: 'Mandlenkosi First Touch'
                }
              ],
              Subject: 'First Touch Contact',
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
        console.log('does not exist')
        fs.mkdirSync(outputDir, { recursive: true });
    } else {
      console.log('existing')
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
  console.log(title, ' ', videoUrl)
  res.json({ title: title, url: videoUrl });
});

//handle webhooks coming from contentful that notifies us if there is a new video or new article
app.post('/webhook/contentful', async (req, res) => {
  const { fields, metadata } = req.body;
  const { title, article } = fields;
  const articleTitle = title['en-US'];
  const articleText = article['en-US'];
  const articleParagraph = articleText.content[0].content[0].value;
  const tags = metadata.tags;

  console.log(req.body)

  /*  
    We extract the articles data that will be used as the notification title and body.
    Then we send notifications only if the article has a tag (tag can be a string with Club name or Breaking News).
    IF the tag is 'breakingNews', we send notifications to all users.
    IF NOT, then we send the notifications to users who follow the specific club(s) that are tagged on the article.
  */
  try {
    const message = {
      title: articleTitle,
      body: `${articleParagraph} ...`,
      // data: { url },
    };

    if(tags.length >= 1){
      const isTagBreakingNews = tags.some(tags => tags.sys.id === 'breakingNews');
      console.log(tags, isTagBreakingNews)

      if(isTagBreakingNews){
        const users = await databases.listDocuments(
          process.env.EXPO_PUBLIC_DATABASE_ID,
          process.env.EXPO_PUBLIC_USER_COLLECTION_ID,
        );
        console.log('NO CLUBS')

        await sendPushNotifications(users, message);
        res.status(200).send('Notification sent successfully.');
      } 
      else {
        const followedClubTags = tags.filter(tag => tag !== 'breakingNews');
        const users = await databases.listDocuments(
          process.env.EXPO_PUBLIC_DATABASE_ID,
          process.env.EXPO_PUBLIC_USER_COLLECTION_ID,
          Query.equal('followingClubs', followedClubTags)
        );

        console.log('CLUBS')

        if(users){
          await sendPushNotifications(users, message);
          res.status(200).send('Notification sent successfully.');
        }
        else {
          res.status(404).send('No users');
        }
      }
    }
  } catch (error) {
    console.error('Error handling webhook:', error);
    res.status(500).send('Failed to handle webhook.');
  }
});

// Function to send push notifications to users
async function sendPushNotifications(users, message) {
  const usersData = users.documents;
  let messages = [];

  // Check that all your push tokens appear to be valid Expo push tokens
  for (let userData of usersData) {
    if (!Expo.isExpoPushToken(userData.pushToken)) {
      console.error(`Invalid push token: ${userData.pushToken}`);
      continue;
    }

    messages.push({
      to: userData.pushToken,
      title: message.title,
      body: message.body,
      data: message.data,
    });
  }

  // The Expo push notification service accepts batches of notifications so
  // that you don't need to send 1000 requests to send 1000 notifications. We
  // recommend you batch your notifications to reduce the number of requests
  // and to compress them (notifications with similar content will get
  // compressed).
  let chunks = expoNotifications.chunkPushNotifications(messages);
  let tickets = [];
  for (let chunk of chunks) {
    try {
      let ticketChunk = await expoNotifications.sendPushNotificationsAsync(chunk);
      tickets.push(...ticketChunk);
    } catch (error) {
      console.error('Error sending push notifications:', error);
    }
  }
}


app.get('/reset', (req, res) => {
  const { userId, secret } = req.query;
  res.redirect(`first-touch://updatePassword?userId=${userId}&secret=${secret}`);
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});