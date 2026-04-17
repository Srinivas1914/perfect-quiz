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
    const claims = { userId: user.id, role: user.role, name: user.name, roll: user.roll, college: user.college, quizId: quizId || user.currentQuizId };
    const token = jwt.sign(claims, JWT_SECRET, { expiresIn: '24h' });
    return res.json({ success: true, token, session: { role: user.role, userId: user.id, name: user.name, roll: user.roll, college: user.college, quizId: user.currentQuizId } });
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

    // 3. Save to memory and MongoDB (non-blocking for faster response)
    syncData['sq_users'] = updatedVal;
    saveData('sq_users', updatedVal).catch(e => console.error('[AUTH] Background save failed:', e));

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
    } else if (key.startsWith('sq_participants')) {
      const qid = key.split('_')[2];
      for (const p of data) {
        await mongoose.model('Participant', new mongoose.Schema({ id: String, name: String, roll: String, score: Number, quizId: String, answers: Object }, { timestamps: true, strict: false }))
          .findOneAndUpdate({ id: p.id, quizId: qid }, { ...p, quizId: qid }, { upsert: true });
      }
    }
  } catch (e) {
    // console.log('Key not in structured format, skipping mirror');
  }
}

async function connectDB() {
  const options = {
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 45000,
  };

  const attemptConnect = async () => {
    try {
      console.log(`[SERVER] 🔌 Attempting to connect to MongoDB...`);
      await mongoose.connect(mongoUri, options);
      console.log('[SERVER] ✅ Connected to MongoDB');
      
      // Initialize after connection
      await initializeData();
      
      // If server isn't started yet, start it
      if (!server.listening) {
        startServer();
      }
    } catch (err) {
      console.error('[SERVER] ❌ MongoDB Connection Failed!');
      console.error(`       Error: ${err.message}`);
      
      // Detailed advice based on connection string
      if (mongoUri.includes('mongodb.net')) {
        console.log('[TIP] You are using MongoDB Atlas. Ensure your current IP is WHITELISTED in Atlas Network Access settings.');
      } else {
        console.log('[TIP] Ensure your local MongoDB service is running (mongod).');
      }
      
      console.log('[SERVER] Retrying connection in 5 seconds...');
      setTimeout(attemptConnect, 5000);
      
      // Start server anyway so the quiz can work in memory, but warn about persistence
      if (!server.listening) {
        console.warn('[SERVER] ⚠️ Starting server in MEMORY-ONLY mode (Persistence Pending Connection)');
        startServer();
      }
    }
  };

  attemptConnect();
}

// Handle connection events for live updates
mongoose.connection.on('disconnected', () => {
  console.warn('[SERVER] ❗ MongoDB Disconnected. Persistence paused.');
});

mongoose.connection.on('reconnected', () => {
  console.log('[SERVER] ♻️ MongoDB Reconnected. Persistence resumed.');
});



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
    // We update local memory first for instant UI response
    syncData[key] = val;

    // Check connection state
    const state = mongoose.connection.readyState;
    
    // If connected (1) or connecting (2), we let Mongoose handle it (with buffering)
    if (state === 1 || state === 2) {
      await StorageModel.findOneAndUpdate({ key }, { val }, { upsert: true });
      await syncToCollections(key, val);
    } else {
      // If disconnected (0) or disconnecting (3), we just keep it in memory
      // The skipped saves in the logs were annoying the user, so we'll only log it once per minute if disconnected
      if (!global._lastDbWarn || Date.now() - global._lastDbWarn > 60000) {
        console.warn(`[SERVER] 💾 Warning: Data saved to MEMORY only. MongoDB is currently unreachable.`);
        global._lastDbWarn = Date.now();
      }
    }
  } catch (e) {
    console.error('[SERVER] Error saving to MongoDB:', e);
  }
}



// ─── SOCKET.IO SYNC ──────────────────────────────────────────
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next();
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback-secret');
    socket.user = decoded;
    next();
  } catch (e) {
    next();
  }
});

io.on('connection', (socket) => {
  const ip = socket.handshake.address;
  const user = socket.user;
  console.log(`[SYNC] User joined: ${ip} (${user ? user.name : 'Guest'})`);
  
  // Send current state to newly connected client
  const keys = Object.keys(syncData);
  if (keys.length > 0) {
    keys.forEach(key => {
      if (key === 'sq_session') return;
      let val = syncData[key];

      // ROLE & COLLEGE BASED DATA ISOLATION (ENFORCED ON BACKEND)
      if (key === 'sq_users') {
        const isSuper = user?.isSuper === true;
        const isAdmin = user?.role === 'admin';
        
        // 1. If not an admin or super admin, they get ZERO users (Security)
        if (!isSuper && !isAdmin) return; 

        // 2. If College Admin (Normal Admin), filter by their assigned college
        if (isAdmin && !isSuper) {
           const users = JSON.parse(val || '[]');
           // Backend Enforced: Only users matching the admin's college are visible
           const institutionalUsers = users.filter(u => u.college === user.college);
           val = JSON.stringify(institutionalUsers);
           console.log(`[SECURITY] Institution Filter: Sending ${institutionalUsers.length} users to ${user.name} (College: ${user.college})`);
        }
        // 3. Super Admin gets the full list (no filter)
      }

      socket.emit('sync', { key, val });
    });
  }

  socket.on('sync', async (data) => {
    if (!data || !data.key) return;
    
    // VERIFY JWT FOR SECURITY
    const token = data.token || socket.handshake.auth?.token;
    const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret';
    
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      
      // ADMIN-COLLEGE DATA ISOLATION FOR USERS
      if (data.key === 'sq_users') {
         if (!decoded.isSuper) {
           if (decoded.role !== 'admin') {
             return console.warn(`[SECURITY] Unauthorized: ${decoded.name} tried to sync sq_users`);
           }
           
           const incomingUsers = JSON.parse(data.val || '[]');
           const existingUsers = JSON.parse(syncData['sq_users'] || '[]');
           
           const adminInst = (decoded.college || '').trim().toLowerCase();
           
           // 1. Keep users from other institutions untouched (Safety Lock)
           const otherInstitutions = existingUsers.filter(u => {
             const uInst = (u.college || '').trim().toLowerCase();
             return uInst !== adminInst;
           });
           
           // 2. Process updates for this admin's institution
           // We filter incoming users that belong to this admin's college
           // CRITICAL: We also AUTO-ASSIGN the college to any users being synced by this admin
           // if they belong to their view (to prevent accidental data loss due to missing fields)
           const myInstitutionalUpdates = incomingUsers.filter(u => {
             const uInst = (u.college || '').trim().toLowerCase();
             // If the user being synced has no college, or it matches the admin's
             return uInst === adminInst || !uInst;
           }).map(u => {
             // Force the college to match exactly the admin's record for consistency
             return { ...u, college: decoded.college };
           });
           
           // 3. Re-merge for consistent storage record
           const merged = [...otherInstitutions, ...myInstitutionalUpdates];
           data.val = JSON.stringify(merged);
           
           console.log(`[SECURITY] Isolation Sync: ${myInstitutionalUpdates.length} users updated for ${decoded.college}.`);
         }
      }

      // Permissions for sensitive configuration keys
      if (['sq_questions', 'sq_rounds', 'sq_settings'].includes(data.key) && decoded.role !== 'admin') {
        return console.warn(`[SECURITY] Unauthorized config sync attempt: ${data.key} by ${decoded.name}`);
      }

      if (data.key === 'sq_session') return; 
      
      syncData[data.key] = data.val;
      await saveData(data.key, data.val);
      socket.broadcast.emit('sync', data);
      
    } catch (err) {
      console.warn(`[SECURITY] Sync rejected: Invalid session from ${ip}`);
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

