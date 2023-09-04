const express = require('express');
const sqlite3 = require('sqlite3');
const { createEventAdapter } = require('@slack/events-api');
const { WebClient } = require('@slack/web-api');
const bodyParser = require('body-parser');

// SQLite database setup
const db = new sqlite3.Database('./database.db');

const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const SLACK_TOKEN = process.env.SLACK_TOKEN;

const slackEvents = createEventAdapter(SLACK_SIGNING_SECRET);
const webClient = new WebClient(SLACK_TOKEN);

const app = express();
const PORT = process.env.PORT || 3000;
app.set('view engine', 'ejs');
app.use(express.static('public'));

db.serialize(() => {
  db.run("CREATE TABLE IF NOT EXISTS users (name TEXT, score INTEGER, last_post_date TEXT, profile_picture TEXT)");
});

app.get('/', (req, res) => {
  res.send('Server is running!');
});

app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});

// Fetch leaderboard
app.get('/leaderboard', (req, res) => {
  db.all("SELECT name, score, profile_picture FROM users ORDER BY score DESC", [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    // Convert the rows into an array of objects with the desired format
    const leaderboard = rows.map(row => {
      return {
        username: row.name,
        points: row.score,
        profile_picture: row.profile_picture
      };
    });

    // Render the EJS template with the leaderboard data
    res.render('index', { leaderboard });
  });
});

slackEvents.on('message', async (event) => {
  try {
    const targetChannelId = "C012943FV6Y"; // #_shipped channel
    const targetChannelName = "";

    if (event.subtype && event.subtype === 'bot_message' || // Ignore bot messages
      event.channel !== targetChannelId || // Ignore messages from other channels
      event.thread_ts && event.thread_ts !== event.ts) { // Ignore thread replies
      return;
    }

    const userInfo = await webClient.users.info({ user: event.user });
    const userName = userInfo.user.profile.display_name || userInfo.user.name;
    const profileImage = userInfo.user.profile.image_192; // 192x192 size image

    const currentDate = new Date().toISOString().split('T')[0];

    const sendUserDM = async (userName) => {
      db.get("SELECT score, (SELECT COUNT(DISTINCT score) FROM users WHERE score >= ?) AS rank FROM users WHERE name = ?", [0, userName], async (err, result) => {
        if (err) {
          console.error(`Error fetching score and rank for user ${userName}:`, err.message);
          return;
        }
        const userScore = result.score;
        const userRank = result.rank;

        try {
          const dmChannel = await webClient.conversations.open({ users: event.user });
          const pointText = userScore === 1 ? 'point' : 'points'; // Determine the appropriate suffix
          const message =`🎉 Congratulations! You've gained a point and now have ${userScore} ${pointText} on the <#${targetChannelId}|${targetChannelName}> leaderboard. You're currently ranked #${userRank}. Check the full leaderboard out here: cosy-bot.studioramen.repl.co/leaderboard`;
          await webClient.chat.postMessage({
            channel: dmChannel.channel.id,
            text: message
          });
        } catch (dmError) {
          console.error(`Error sending DM to user ${userName}:`, dmError.message);
        }
      });
    };

    db.get("SELECT * FROM users WHERE name = ?", [userName], (err, user) => {
      if (err) {
        console.error(`Error retrieving user ${userName} from database:`, err.message);
        return;
      }

      if (user) {
        if (!user.last_post_date) {
          db.run("UPDATE users SET score = 1, last_post_date = ?, profile_picture = ? WHERE name = ?", [currentDate, profileImage, userName], async (err) => {
            if (err) {
              console.error(`Error initializing score and post date for user ${userName}:`, err.message);
            }
            await sendUserDM(userName);
          });
        } else {
          const lastPostDate = new Date(user.last_post_date);
          const differenceInDays = (new Date(currentDate) - lastPostDate) / (1000 * 60 * 60 * 24);

          if (differenceInDays === 1) {
            db.run("UPDATE users SET score = score + 1, last_post_date = ?, profile_picture = ? WHERE name = ?", [currentDate, profileImage, userName], async (err) => {
              if (err) {
                console.error(`Error incrementing score for user ${userName}:`, err.message);
              }
              await sendUserDM(userName);
            });
          } else if (differenceInDays > 1) {
            db.run("UPDATE users SET score = 1, last_post_date = ?, profile_picture = ? WHERE name = ?", [currentDate, profileImage, userName], async (err) => {
              if (err) {
                console.error(`Error resetting score for user ${userName}:`, err.message);
              }
              await sendUserDM(userName);
            });
          }
        }
      } else {
        db.run("INSERT INTO users (name, score, last_post_date, profile_picture) VALUES (?, 1, ?, ?)", [userName, currentDate, profileImage], async (err) => {
          if (err) {
            console.error(`Error adding user ${userName} to database:`, err.message);
          }
          await sendUserDM(userName);
        });
      }
    });

  } catch (error) {
    console.error('Error handling Slack event:', error.message, error.stack);
  }
});

app.use('/slack/events', slackEvents.requestListener());