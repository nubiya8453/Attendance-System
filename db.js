const fs = require('fs');
const path = require('path');

// If running on Vercel, write local fallback files to /tmp/data which is writable.
// If running locally, write to __dirname/data.
const DATA_DIR = process.env.VERCEL ? '/tmp/data' : path.join(__dirname, 'data');
const STUDENTS_FILE = path.join(DATA_DIR, 'students.json');
const ATTENDANCE_FILE = path.join(DATA_DIR, 'attendance.json');
const EMAILS_FILE = path.join(DATA_DIR, 'emails.json');
const SMS_FILE = path.join(DATA_DIR, 'sms.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Initialize files by copying from read-only project bundle or writing default data
const initFile = (fileName, defaultData) => {
  const targetPath = path.join(DATA_DIR, fileName);
  if (!fs.existsSync(targetPath)) {
    const srcPath = path.join(__dirname, 'data', fileName);
    if (fs.existsSync(srcPath)) {
      try {
        fs.copyFileSync(srcPath, targetPath);
        console.log(`[DB] Copied initial ${fileName} to writable space at ${targetPath}`);
        return;
      } catch (err) {
        console.error(`[DB] Failed to copy initial ${fileName}:`, err);
      }
    }
    fs.writeFileSync(targetPath, JSON.stringify(defaultData, null, 2), 'utf8');
  }
};

initFile('students.json', {});
initFile('attendance.json', []);
initFile('emails.json', []);
initFile('sms.json', []);

const readJson = (filePath) => {
  try {
    const data = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error(`Error reading ${filePath}:`, error);
    return null;
  }
};

const writeJson = (filePath, data) => {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.error(`Error writing to ${filePath}:`, error);
    return false;
  }
};

const Redis = require('ioredis');

const isRedisEnabled = !!process.env.REDIS_URL;
const isKvEnabled = !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);

let redisClient = null;
if (isRedisEnabled) {
  try {
    redisClient = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 1
    });
    console.log('[DB] Redis client initialized via REDIS_URL.');
  } catch (err) {
    console.error('[DB] Failed to initialize Redis client:', err);
  }
} else if (isKvEnabled) {
  console.log('[DB] Vercel KV REST cloud integration detected.');
} else {
  console.log('[DB] Cloud database environment variables missing. Falling back to local JSON database.');
}

async function runKvCommand(command) {
  const baseUrl = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  
  const url = baseUrl.endsWith('/pipeline') ? baseUrl : `${baseUrl}/pipeline`;
  
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify([command])
  });
  
  if (!res.ok) {
    throw new Error(`Upstash Redis HTTP error! status: ${res.status} info: ${res.statusText}`);
  }
  
  const json = await res.json();
  if (Array.isArray(json) && json[0]) {
    if (json[0].error) {
      throw new Error(`Upstash Redis command error: ${json[0].error}`);
    }
    return json[0].result;
  }
  throw new Error('Invalid response format from Upstash Redis pipeline.');
}

async function getKv(key) {
  if (isRedisEnabled && redisClient) {
    try {
      return await redisClient.get(key);
    } catch (err) {
      console.error(`[DB] Redis GET error for key ${key}:`, err);
    }
  }
  if (isKvEnabled) {
    try {
      return await runKvCommand(['GET', key]);
    } catch (err) {
      console.error(`[DB] Vercel KV GET error for key ${key}:`, err);
    }
  }
  return null;
}

async function setKv(key, value) {
  if (isRedisEnabled && redisClient) {
    try {
      await redisClient.set(key, value);
      return true;
    } catch (err) {
      console.error(`[DB] Redis SET error for key ${key}:`, err);
    }
  }
  if (isKvEnabled) {
    try {
      await runKvCommand(['SET', key, value]);
      return true;
    } catch (err) {
      console.error(`[DB] Vercel KV SET error for key ${key}:`, err);
    }
  }
  return false;
}

module.exports = {
  getStudents: async () => {
    try {
      const data = await getKv('students');
      return data ? JSON.parse(data) : readJson(STUDENTS_FILE) || {};
    } catch (err) {
      console.error('[DB] Failed to get students, falling back to local file:', err);
      return readJson(STUDENTS_FILE) || {};
    }
  },
  
  saveStudents: async (students) => {
    try {
      const success = await setKv('students', JSON.stringify(students));
      if (success) return true;
      return writeJson(STUDENTS_FILE, students);
    } catch (err) {
      console.error('[DB] Failed to save students, falling back to local file:', err);
      return writeJson(STUDENTS_FILE, students);
    }
  },
  
  getAttendance: async () => {
    try {
      const data = await getKv('attendance');
      return data ? JSON.parse(data) : readJson(ATTENDANCE_FILE) || [];
    } catch (err) {
      console.error('[DB] Failed to get attendance, falling back to local file:', err);
      return readJson(ATTENDANCE_FILE) || [];
    }
  },
  
  saveAttendance: async (attendance) => {
    try {
      const success = await setKv('attendance', JSON.stringify(attendance));
      if (success) return true;
      return writeJson(ATTENDANCE_FILE, attendance);
    } catch (err) {
      console.error('[DB] Failed to save attendance, falling back to local file:', err);
      return writeJson(ATTENDANCE_FILE, attendance);
    }
  },
  
  getEmails: async () => {
    try {
      const data = await getKv('emails');
      return data ? JSON.parse(data) : readJson(EMAILS_FILE) || [];
    } catch (err) {
      console.error('[DB] Failed to get emails, falling back to local file:', err);
      return readJson(EMAILS_FILE) || [];
    }
  },
  
  saveEmails: async (emails) => {
    try {
      const success = await setKv('emails', JSON.stringify(emails));
      if (success) return true;
      return writeJson(EMAILS_FILE, emails);
    } catch (err) {
      console.error('[DB] Failed to save emails, falling back to local file:', err);
      return writeJson(EMAILS_FILE, emails);
    }
  },
  
  getSms: async () => {
    try {
      const data = await getKv('sms');
      return data ? JSON.parse(data) : readJson(SMS_FILE) || [];
    } catch (err) {
      console.error('[DB] Failed to get sms, falling back to local file:', err);
      return readJson(SMS_FILE) || [];
    }
  },
  
  saveSms: async (sms) => {
    try {
      const success = await setKv('sms', JSON.stringify(sms));
      if (success) return true;
      return writeJson(SMS_FILE, sms);
    } catch (err) {
      console.error('[DB] Failed to save sms, falling back to local file:', err);
      return writeJson(SMS_FILE, sms);
    }
  }
};
