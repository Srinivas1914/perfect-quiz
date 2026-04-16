require('dotenv').config();
const express = require('express');

const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json()); // Essential for API login
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});


// Serve built assets from 'dist' directory in production, otherwise serve root
const isProduction = process.env.NODE_ENV === 'production' || process.env.RENDER === 'true';
const staticDir = isProduction ? path.join(__dirname, 'dist') : __dirname;
console.log(`[SERVER] Environment: ${isProduction ? 'PRODUCTION' : 'DEVELOPMENT'}`);
console.log(`[SERVER] Serving static files from: ${staticDir}`);

app.use(express.static(staticDir));
if (!isProduction) {
  app.use(express.static(path.join(__dirname, 'public')));
}

// Routes for clean URLs
app.get('/', (req, res) => {
  res.sendFile(path.join(staticDir, 'index.html'));
});

// Routes for clean URLs
app.get('/superadmin', (req, res) => res.sendFile(path.join(staticDir, 'pages/superadmin.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(staticDir, 'pages/admin.html')));
app.get('/participant', (req, res) => res.sendFile(path.join(staticDir, 'pages/participant.html')));
app.get('/team/:name', (req, res) => res.sendFile(path.join(staticDir, 'pages/team.html')));


// ─── AUTHENTICATION API ──────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { username, password, quizId } = req.body;
  const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret';

  // 1. Check Super Admin
  const settingsStr = syncData['sq_settings'];
  const settings = settingsStr ? JSON.parse(settingsStr) : {};
  if (username === (settings.adminUsername || 'srinivas') && password === (settings.adminPassword || 'sri@1119')) {
    const token = jwt.sign({ role: 'admin', isSuper: true, name: 'Super Admin' }, JWT_SECRET, { expiresIn: '24h' });
    return res.json({ success: true, token, session: { role: 'admin', isSuper: true } });
  }

  // 2. Check Database Users (Normal Admin, Participant, Viewer)
  const usersStr = syncData['sq_users'];
  const users = usersStr ? JSON.parse(usersStr) : [];
  const user = users.find(u => u.username === username && u.password === password);

  if (user) {
    const claims = { userId: user.id, role: user.role, name: user.name, quizId: quizId || user.currentQuizId };
    const token = jwt.sign(claims, JWT_SECRET, { expiresIn: '24h' });
    return res.json({ success: true, token, session: { role: user.role, userId: user.id, name: user.name, quizId: user.currentQuizId } });
  }

  // 3. Check Teams
  const teamsStr = syncData[`sq_teams${quizId ? '_' + quizId : ''}`];
  const teams = teamsStr ? JSON.parse(teamsStr) : [];
  const team = teams.find(t => t.username === username && t.password === password);
  
  if (team) {
    const token = jwt.sign({ teamId: team.id, role: 'team', name: team.name, quizId }, JWT_SECRET, { expiresIn: '24h' });
    return res.json({ success: true, token, session: { role: 'team', teamId: team.id, name: team.name, quizId } });
  }

  return res.status(401).json({ success: false, message: 'Invalid credentials' });
});

app.post('/api/register', async (req, res) => {
  try {
    const newUser = req.body;
    if (!newUser || !newUser.username) return res.status(400).json({ success: false, message: 'Invalid user data' });

    // 1. Get current users from memory
    const usersStr = syncData['sq_users'];
    const users = usersStr ? JSON.parse(usersStr) : [];

    // 2. Add new user (no more 'taken' check here as requested)
    users.push(newUser);
    const updatedVal = JSON.stringify(users);

    // 3. Save to memory and MongoDB
    syncData['sq_users'] = updatedVal;
    await saveData('sq_users', updatedVal);

    // 4. Broadcast the update to all connected clients
    io.emit('sync', { key: 'sq_users', val: updatedVal });

    console.log(`[AUTH] New registration: ${newUser.username} (${newUser.name})`);
    res.json({ success: true });
  } catch (err) {
    console.error('[AUTH] Registration error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.post('/api/reports', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ success: false, message: 'No token' });
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback-secret');
    if (decoded.role !== 'admin') return res.status(403).json({ success: false, message: 'Forbidden' });

    const report = req.body;
    report.adminId = decoded.id;
    await ReportModel.findOneAndUpdate({ id: report.id }, report, { upsert: true });

    console.log(`[REPORT] Saved ${report.type} for quiz ${report.quizId}`);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.get('/api/reports/:quizId', async (req, res) => {
  try {
    const { quizId } = req.params;
    const reports = await ReportModel.find({ quizId }).sort({ timestamp: -1 });
    res.json({ success: true, reports });
  } catch (e) {
    res.status(500).json({ success: false });
  }
});




const mongoose = require('mongoose');

// MongoDB setup with improved options
const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/quizdb';

// Disable buffering to prevent timeout errors if DB is unreachable
mongoose.set('bufferCommands', false);

const storageSchema = new mongoose.Schema({
  key: { type: String, unique: true },
  val: String
});
const StorageModel = mongoose.model('Storage', storageSchema);

// ─── STRUCTURED MODELS FOR QUERIES ───────────────────────────
const userSchema = new mongoose.Schema({
  id: { type: String, unique: true },
  name: String,
  username: { type: String },
  password: { type: String, select: false },
  role: String,
  quizId: String,
  currentQuizId: String,
  college: String,
  dept: String,
  year: String
}, { timestamps: true });

const teamSchema = new mongoose.Schema({
  id: { type: String, unique: true },
  name: String,
  username: String,
  quizId: String,
  score: { type: Number, default: 0 },
  status: String,
  memberIds: [String]
}, { timestamps: true });

const questionSchema = new mongoose.Schema({
  id: { type: String, unique: true },
  text: String,
  options: [String],
  correct: [Number],
  quizId: String
});

const reportSchema = new mongoose.Schema({
  id: { type: String, unique: true },
  quizId: String,
  adminId: String,
  type: String, // 'summary' or 'overall'
  timestamp: { type: Number, default: Date.now },
  data: Object
});

const ReportModel = mongoose.model('Report', reportSchema);
const UserModel = mongoose.model('User', userSchema);
const TeamModel = mongoose.model('Team', teamSchema);
const QuestionModel = mongoose.model('Question', questionSchema);

async function syncToCollections(key, val) {
  try {
    const data = JSON.parse(val);
    if (key === 'sq_users') {
      for (const u of data) {
        await UserModel.findOneAndUpdate({ id: u.id }, u, { upsert: true });
      }
    } else if (key.startsWith('sq_teams')) {
      const qid = key.split('_')[2]; 
      for (const t of data) {
        await TeamModel.findOneAndUpdate({ id: t.id }, { ...t, quizId: qid }, { upsert: true });
      }
    } else if (key.startsWith('sq_questions')) {
      const qid = key.split('_')[2];
      for (const q of data) {
        await QuestionModel.findOneAndUpdate({ id: q.id }, { ...q, quizId: qid }, { upsert: true });
      }
    }
  } catch (e) {
    // console.log('Key not in structured format, skipping mirror');
  }
}

async function connectDB() {
  try {
    console.log('[SERVER] Connecting to MongoDB...');
    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 5000,
      autoIndex: true,
    });
    console.log('[SERVER] ✅ Connected to MongoDB');
    await initializeData();
    startServer();
  } catch (err) {
    console.error('[SERVER] ❌ MongoDB Connection Failed!');
    console.error(`       URI: ${mongoUri}`);
    console.error(`       Error: ${err.message}`);
    console.log('\n[TIP] Check if MongoDB is installed and running.');
    console.log('[TIP] You can install MongoDB Compass to manage your database easily.\n');
    console.log('[SERVER] Server starting in LIMITED/LOCAL mode without persistence...');
    startServer();
  }
}



const fs = require('fs');
const DATA_FILE = path.join(__dirname, 'data.json');
let syncData = {};

async function initializeData() {
  try {
    const docs = await StorageModel.find({});
    if (docs.length > 0) {
      console.log(`[SERVER] Loaded ${docs.length} keys from MongoDB`);
      docs.forEach(doc => { syncData[doc.key] = doc.val; });
    } else if (fs.existsSync(DATA_FILE)) {
      // Migration from data.json to MongoDB
      console.log('[SERVER] MongoDB empty. Migrating from data.json...');
      const fileData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      for (const key in fileData) {
        if (key === 'sq_session') continue; // Skip session data
        syncData[key] = fileData[key];
        await StorageModel.findOneAndUpdate({ key }, { val: fileData[key] }, { upsert: true });
      }
      console.log('[SERVER] Migration complete.');
    }
  } catch (e) {
    console.error('[SERVER] Error initializing data:', e);
  }
}

async function saveData(key, val) {
  try {
    // Only attempt save if MongoDB is connected
    if (mongoose.connection.readyState === 1) {
      await StorageModel.findOneAndUpdate({ key }, { val }, { upsert: true });
      // NEW: Also mirror to structured collections for better queries/validation
      await syncToCollections(key, val);
    } else {
      console.warn(`[SERVER] Skipping MongoDB save for ${key} (No Connection)`);
    }
  } catch (e) {
    console.error('[SERVER] Error saving to MongoDB:', e);
  }
}



io.on('connection', (socket) => {
  const ip = socket.handshake.address;
  console.log(`[SYNC] User joined: ${ip}`);
  
  // Send current state to newly connected client
  const keys = Object.keys(syncData);
  if (keys.length > 0) {
    console.log(`[SYNC] Sending initial state (${keys.length} keys) to ${ip}`);
    keys.forEach(key => {
      if (key === 'sq_session') return; // NEVER send remote sessions to new clients
      socket.emit('sync', { key, val: syncData[key] });
    });
  }

  // Received a change from one client, broadcast to all others and save
  socket.on('sync', async (data) => {
    if (!data || !data.key) return;
    
    // VERIFY JWT FOR SECURITY
    const token = data.token || socket.handshake.auth?.token;
    const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret';
    
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      
      // OPTIONAL: Add granular permission logic here
      // Example: Regular user can't edit 'sq_questions'
      if (['sq_questions', 'sq_rounds', 'sq_settings'].includes(data.key) && decoded.role !== 'admin') {
        return console.warn(`[SECURITY] Unauthorized sync attempt for ${data.key} by ${decoded.name}`);
      }

      if (['sq_quiz', 'sq_quiz_requests'].includes(data.key) && data.key === 'sq_quiz' && decoded.role !== 'admin' && decoded.role !== 'team') {
         // Allow teams to update quiz status if needed (e.g. they answered), but usually only admin
      }

      if (data.key === 'sq_session') return; 
      
      syncData[data.key] = data.val;
      await saveData(data.key, data.val);
      socket.broadcast.emit('sync', data);
      
      if (['sq_quiz', 'sq_rounds', 'sq_questions'].includes(data.key)) {
        console.log(`[SYNC] Secured update: ${data.key} from ${decoded.name || ip}`);
      }
    } catch (err) {
      console.warn(`[SECURITY] Sync rejected: Invalid or missing token from ${ip}`);
    }
  });

  
  socket.on('disconnect', () => {
    console.log(`[SYNC] User left: ${ip}`);
  });
});

const PORT = process.env.PORT || 8080;

function startServer() {
  server.listen(PORT, '0.0.0.0', () => {
    const nets = os.networkInterfaces();
    console.log('\n=========================================');
    console.log('🚀 QUIZ MASTER SERVER RUNNING');
    console.log(`-----------------------------------------`);
    console.log(`Local:   http://localhost:${PORT}`);
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) {
          console.log(`Network: http://${net.address}:${PORT}`);
        }
      }
    }
    console.log('=========================================\n');
  });
}

// Kick off connection
connectDB();

