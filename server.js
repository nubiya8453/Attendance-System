require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const schedule = require('node-schedule');
const nodemailer = require('nodemailer');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Middleware to disable caching for API endpoints
const noCache = (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  next();
};

app.use('/api', noCache);

app.use(express.static(path.join(__dirname, 'public')));

// Authentication configurations
const FACULTY_USER = 'admin';
const FACULTY_PASS = 'admin123';
const FACULTY_TOKEN = 'secret-faculty-token-2026';

// Middleware to protect faculty-only endpoints
const requireFaculty = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Faculty authentication token required.' });
  }
  const token = authHeader.split(' ')[1];
  if (token !== FACULTY_TOKEN) {
    return res.status(403).json({ error: 'Forbidden: Invalid authentication token.' });
  }
  next();
};

// Period Schedule Configuration
const PERIODS = [
  { number: 1, name: 'Period 1', start: '09:00 AM', end: '09:55 AM', minStart: 540, minEnd: 595 },
  { number: 2, name: 'Period 2', start: '09:55 AM', end: '10:50 AM', minStart: 595, minEnd: 650 },
  { number: 3, name: 'Period 3', start: '11:10 AM', end: '12:05 PM', minStart: 670, minEnd: 725 },
  { number: 4, name: 'Period 4', start: '12:05 PM', end: '01:00 PM', minStart: 725, minEnd: 780 },
  { number: 5, name: 'Period 5', start: '02:00 PM', end: '02:55 PM', minStart: 840, minEnd: 895 },
  { number: 6, name: 'Period 6', start: '02:55 PM', end: '03:50 PM', minStart: 895, minEnd: 950 }
];

const BREAKS = [
  { name: 'Leisure Break', start: '10:50 AM', end: '11:10 AM', minStart: 650, minEnd: 670 },
  { name: 'Lunch Break', start: '01:00 PM', end: '02:00 PM', minStart: 780, minEnd: 840 }
];

// Helper: Get timezone-safe Asia/Kolkata details
const getAsiaKolkataTimeDetails = () => {
  const options = { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false };
  const formatter = new Intl.DateTimeFormat('en-US', options);
  const parts = formatter.formatToParts(new Date());
  
  const dict = {};
  parts.forEach(p => {
    dict[p.type] = p.value;
  });
  
  const minutes = parseInt(dict.hour) * 60 + parseInt(dict.minute);
  const dateStr = `${dict.year}-${dict.month}-${dict.day}`;
  return { minutes, dateStr };
};

// Helper: Determine active period based on time (in minutes since midnight)
const getActivePeriod = () => {
  const { minutes } = getAsiaKolkataTimeDetails();

  // Check periods
  for (const p of PERIODS) {
    if (minutes >= p.minStart && minutes < p.minEnd) {
      const attendanceClosed = (minutes - p.minStart) >= 10;
      return { type: 'period', data: { ...p, attendanceClosed, minutesElapsed: minutes - p.minStart } };
    }
  }

  // Check breaks
  for (const b of BREAKS) {
    if (minutes >= b.minStart && minutes < b.minEnd) {
      return { type: 'break', data: b };
    }
  }

  return { type: 'off', data: { name: 'College Closed', start: '03:50 PM', end: '09:00 AM' } };
};

// Helper: Standardize and validate Indian mobile numbers
const cleanIndianPhoneNumber = (phone) => {
  if (!phone) return '';
  let cleaned = phone.replace(/\D/g, '');
  if (cleaned.startsWith('0091')) {
    cleaned = cleaned.substring(2);
  }
  if (cleaned.startsWith('0') && cleaned.length === 11) {
    cleaned = cleaned.substring(1);
  }
  if (cleaned.length === 10) {
    cleaned = '91' + cleaned;
  }
  return cleaned;
};


const INCEPTION_DATE = '2026-06-01';

// Get list of all periods conducted since inception up to today (timezone safe)
const getConductedSessions = (attendanceLogs) => {
  let startDateStr = INCEPTION_DATE;
  attendanceLogs.forEach(log => {
    if (log.date < startDateStr) {
      startDateStr = log.date;
    }
  });

  const sessions = [];
  const start = new Date(startDateStr);
  const { minutes: currentMinutes, dateStr: todayStr } = getAsiaKolkataTimeDetails();
  const end = new Date(todayStr);

  let current = new Date(start);
  while (current <= end) {
    const dStr = current.toISOString().split('T')[0];
    
    // For each date, check all 6 periods
    for (const p of PERIODS) {
      if (dStr < todayStr) {
        sessions.push({ date: dStr, period: p.number });
      } else if (dStr === todayStr) {
        // Only count periods that have already started today
        if (currentMinutes >= p.minStart) {
          sessions.push({ date: dStr, period: p.number });
        }
      }
    }
    current.setDate(current.getDate() + 1);
  }
  return sessions;
};

// Calculate attendance stats (percentage, count) for all students
const calculateStats = async () => {
  const studentsObj = await db.getStudents();
  const attendance = await db.getAttendance();

  const conductedSessions = getConductedSessions(attendance);
  const totalEvaluatedCount = conductedSessions.length;
  const studentsCount = Object.keys(studentsObj).length;

  // Compile list of students
  const studentList = Object.keys(studentsObj).map(usn => {
    const student = studentsObj[usn];
    
    // Count how many of the conducted sessions this student attended
    let attendedCount = 0;
    conductedSessions.forEach(session => {
      const present = attendance.some(log => 
        log.usn === usn && 
        log.date === session.date && 
        log.period === session.period && 
        log.status === 'present'
      );
      if (present) {
        attendedCount++;
      }
    });

    const percentage = totalEvaluatedCount > 0 
      ? Math.round((attendedCount / totalEvaluatedCount) * 1000) / 10 
      : 100.0;

    return {
      usn: student.usn,
      name: student.name,
      email: student.email,
      phone: student.phone,
      attendancePercentage: percentage,
      attendedCount,
      totalEvaluatedCount
    };
  });

  // Sort chronologically (USN wise)
  studentList.sort((a, b) => a.usn.localeCompare(b.usn));

  // Compute Period-wise Stats (P1 - P6)
  const periodStats = PERIODS.map(p => {
    const totalSessionsForP = conductedSessions.filter(s => s.period === p.number).length;
    const totalPresentsForP = attendance.filter(log => log.period === p.number && log.status === 'present').length;
    const rate = studentsCount > 0 && totalSessionsForP > 0
      ? Math.round((totalPresentsForP / (totalSessionsForP * studentsCount)) * 1000) / 10
      : 100.0;
    return {
      period: p.number,
      name: p.name,
      rate
    };
  });

  // Compute 7-day Daily Trends
  const uniqueDates = [...new Set(conductedSessions.map(s => s.date))].sort().slice(-7);
  const dailyStats = uniqueDates.map(date => {
    const sessionsCountOnD = conductedSessions.filter(s => s.date === date).length;
    const presentsOnD = attendance.filter(log => log.date === date && log.status === 'present').length;
    const rate = studentsCount > 0 && sessionsCountOnD > 0
      ? Math.round((presentsOnD / (sessionsCountOnD * studentsCount)) * 1000) / 10
      : 100.0;
    return {
      date,
      rate
    };
  });

  return {
    students: studentList,
    totalEvaluatedSessions: totalEvaluatedCount,
    periodStats,
    dailyStats
  };
};

// SMTP Transporter setup (simulated fallback)
const getMailTransporter = () => {
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (user && pass) {
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user, pass }
    });
  }
  return null;
};// Core Action: Generate and Send Absentee Emails and SMS for a specific date
const triggerAbsenteeEmailJob = async (targetDate) => {
  const studentsObj = await db.getStudents();
  const attendance = await db.getAttendance();
  const emails = await db.getEmails();
  const smsList = await db.getSms();
  const stats = await calculateStats();

  const results = [];
  const transporter = getMailTransporter();

  // Find all attendance logs for this target date
  const todayLogs = attendance.filter(log => log.date === targetDate);

  // Check each student
  for (const usn in studentsObj) {
    const student = studentsObj[usn];
    const missedPeriods = [];
    const periodStates = [];

    // Verify status for each of the 6 periods today
    PERIODS.forEach(p => {
      const isPresent = todayLogs.some(log => log.usn === usn && log.period === p.number && log.status === 'present');
      periodStates.push({
        number: p.number,
        name: p.name,
        time: `${p.start} - ${p.end}`,
        status: isPresent ? 'Present' : 'Absent'
      });

      if (!isPresent) {
        missedPeriods.push(p);
      }
    });

    // If student was absent in ANY period today
    if (missedPeriods.length > 0) {
      // Find overall attendance percentage
      const studentStats = stats.students.find(s => s.usn === usn) || { attendancePercentage: 100.0 };
      const currentPercentage = studentStats.attendancePercentage;

      // Construct Email Body
      const periodRows = periodStates.map(p => `
        <tr style="border-bottom: 1px solid #dee2e6;">
          <td style="padding: 10px; font-weight: bold; border: 1px solid #dee2e6;">${p.name}</td>
          <td style="padding: 10px; border: 1px solid #dee2e6; color: #555;">${p.time}</td>
          <td style="padding: 10px; text-align: center; border: 1px solid #dee2e6; font-weight: bold; color: ${p.status === 'Present' ? '#2e7d32' : '#c62828'};">
            ${p.status}
          </td>
        </tr>
      `).join('');

      const warningColor = currentPercentage >= 75 ? '#2e7d32' : '#d32f2f';

      const emailSubject = `Absence Alert: Period-wise Attendance Report - ${targetDate}`;
      const emailHtml = `
        <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: auto; padding: 25px; border: 1px solid #e0e0e0; border-radius: 12px; background-color: #ffffff; color: #333333; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
          <div style="text-align: center; padding-bottom: 15px; border-bottom: 2px solid #ef5350;">
            <h2 style="color: #d32f2f; margin: 0; font-size: 24px; letter-spacing: 0.5px;">Absence Notification Alert</h2>
            <p style="margin: 5px 0 0 0; color: #777; font-size: 14px;">AI Attendance Monitor System</p>
          </div>
          
          <div style="padding: 20px 0;">
            <p style="font-size: 16px; margin-top: 0;">Dear <strong>${student.name}</strong>,</p>
            <p style="font-size: 14px; line-height: 1.6; color: #555;">
              You have been marked <strong>ABSENT</strong> for one or more classes on <strong>${targetDate}</strong>. Details of your daily classes are listed below:
            </p>
            
            <table style="width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 14px;">
              <thead>
                <tr style="background-color: #f5f5f5;">
                  <th style="border: 1px solid #dee2e6; padding: 12px; text-align: left; font-weight: 600;">Period</th>
                  <th style="border: 1px solid #dee2e6; padding: 12px; text-align: left; font-weight: 600;">Time Slot</th>
                  <th style="border: 1px solid #dee2e6; padding: 12px; text-align: center; font-weight: 600;">Status</th>
                </tr>
              </thead>
              <tbody>
                ${periodRows}
              </tbody>
            </table>

            <div style="background-color: #fafafa; padding: 20px; border-radius: 8px; border-left: 5px solid ${warningColor}; margin-top: 25px;">
              <h4 style="margin: 0 0 10px 0; color: #444; font-size: 15px;">Cumulative Performance Summary</h4>
              <p style="margin: 0; font-size: 16px;">
                <strong>Overall Attendance Percentage:</strong> 
                <span style="color: ${warningColor}; font-size: 18px; font-weight: 700; margin-left: 5px;">${currentPercentage}%</span>
              </p>
              <p style="margin: 8px 0 0 0; font-size: 12px; color: #888; line-height: 1.4;">
                Note: Standard college regulations require a minimum of 75% attendance. Falling below this threshold may lead to academic restrictions.
              </p>
            </div>
          </div>
          
          <div style="border-top: 1px solid #e0e0e0; padding-top: 15px; text-align: center; font-size: 12px; color: #999;">
            <p style="margin: 0;">This is an automated notification sent after 5:00 PM.</p>
            <p style="margin: 5px 0 0 0;">If this record is incorrect, please coordinate with your class mentor.</p>
          </div>
        </div>
      `;

      let mailStatus = 'Simulated (Log Saved)';
      if (transporter) {
        try {
          await transporter.sendMail({
            from: `"College Attendance System" <${process.env.SMTP_USER}>`,
            to: student.email,
            subject: emailSubject,
            html: emailHtml
          });
          mailStatus = 'Sent Successfully';
        } catch (error) {
          console.error(`Failed to send actual email to ${student.email}:`, error);
          mailStatus = `Error Sending: ${error.message}`;
        }
      }

      // Record Email in database
      const emailRecord = {
        id: `email_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        to: student.email,
        studentName: student.name,
        usn: student.usn,
        date: targetDate,
        subject: emailSubject,
        body: emailHtml,
        timestamp: new Date().toISOString(),
        status: mailStatus
      };
      emails.unshift(emailRecord);

      // Record SMS in database
      const missedPeriodNames = missedPeriods.map(p => `P${p.number}`).join(', ');
      const smsBody = `Alert: Dear ${student.name} (${student.usn}), you were marked ABSENT for period(s) (${missedPeriodNames}) on ${targetDate}. Cumulative Attendance: ${currentPercentage}%. Please coordinate with your class mentor.`;
      
      const smsRecord = {
        id: `sms_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        to: student.phone || 'N/A',
        studentName: student.name,
        usn: student.usn,
        date: targetDate,
        body: smsBody,
        timestamp: new Date().toISOString(),
        status: 'Sent (Simulated)'
      };
      smsList.unshift(smsRecord);

      results.push({ usn, name: student.name, status: mailStatus, missedCount: missedPeriods.length });
    }
  }

  await db.saveEmails(emails);
  await db.saveSms(smsList);
  return results;
};
// Scheduled Job: Runs every day at 5:00 PM (17:00) IST
schedule.scheduleJob('0 17 * * *', async () => {
  const { dateStr } = getAsiaKolkataTimeDetails();
  console.log(`[Scheduler] Triggering 5:00 PM attendance email check for ${dateStr}...`);
  try {
    const results = await triggerAbsenteeEmailJob(dateStr);
    console.log(`[Scheduler] 5:00 PM check complete. Processed ${results.length} absentees.`, results);
  } catch (error) {
    console.error(`[Scheduler] Error in 5:00 PM absentee job:`, error);
  }
});

// API Routes

// 1. Faculty Authentication Endpoint
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === FACULTY_USER && password === FACULTY_PASS) {
    return res.json({ success: true, token: FACULTY_TOKEN });
  }
  res.status(401).json({ error: 'Invalid faculty username or password.' });
});

// 2. Get Active Period Info (Public)
app.get('/api/period', (req, res) => {
  const { simulated, simPeriod, simElapsed } = req.query;
  
  if (simulated === 'true') {
    const periodNum = parseInt(simPeriod);
    const p = PERIODS.find(x => x.number === periodNum);
    if (p) {
      const attendanceClosed = simElapsed === 'closed';
      return res.json({
        type: 'period',
        data: {
          ...p,
          attendanceClosed,
          minutesElapsed: attendanceClosed ? 15 : 5
        }
      });
    }
  }
  
  res.json(getActivePeriod());
});

// 3. Mark Attendance (Public - Triggered by Webcam)
app.post('/api/attendance', async (req, res) => {
  let { usn, period, date, status, simulated, simElapsed } = req.body;

  if (!usn || !period) {
    return res.status(400).json({ error: 'USN and period are required parameters.' });
  }

  const cleanUsn = usn.trim().toUpperCase();
  const students = await db.getStudents();

  if (!students[cleanUsn]) {
    return res.status(404).json({ error: `Student with USN ${cleanUsn} is not registered.` });
  }

  period = parseInt(period);
  if (isNaN(period) || period < 1 || period > 6) {
    return res.status(400).json({ error: 'Period must be an integer between 1 and 6.' });
  }

  const { minutes: currentMinutes, dateStr: localTodayStr } = getAsiaKolkataTimeDetails();

  if (!date) {
    date = localTodayStr;
  }
  if (!status) {
    status = 'present';
  }

  // Check Faculty Authorization (bypass all timing checks for faculty)
  const authHeader = req.headers.authorization;
  const isFaculty = authHeader && authHeader.startsWith('Bearer ') && authHeader.split(' ')[1] === FACULTY_TOKEN;

  if (!isFaculty) {
    if (simulated === true) {
      if (simElapsed === 'closed') {
        return res.status(400).json({ error: `Attendance window for Period ${period} is closed (Simulation).` });
      }
    } else {
      // Real clock lockout window checks
      if (date !== localTodayStr) {
        return res.status(400).json({ error: 'Attendance can only be marked for today\'s date.' });
      }

      const pConfig = PERIODS.find(p => p.number === period);
      if (!pConfig) {
        return res.status(400).json({ error: 'Invalid period number.' });
      }

      // Check if period is running
      const isPeriodRunning = currentMinutes >= pConfig.minStart && currentMinutes < pConfig.minEnd;
      if (!isPeriodRunning) {
        return res.status(400).json({ error: `Attendance cannot be marked now. Period ${period} runs from ${pConfig.start} to ${pConfig.end}.` });
      }

      // Check 10-minute lockout window
      const elapsed = currentMinutes - pConfig.minStart;
      if (elapsed > 10) {
        return res.status(400).json({ error: `Attendance window closed. Student check-in is restricted to the first 10 minutes (until ${(pConfig.minStart + 10) % 60} mins).` });
      }
    }
  }

  const attendance = await db.getAttendance();

  // Find if entry already exists
  const existingIdx = attendance.findIndex(log => log.usn === cleanUsn && log.date === date && log.period === period);

  if (existingIdx !== -1) {
    attendance[existingIdx].status = status;
    attendance[existingIdx].timestamp = new Date().toISOString();
  } else {
    attendance.push({
      date,
      usn: cleanUsn,
      period,
      status,
      timestamp: new Date().toISOString()
    });
  }

  await db.saveAttendance(attendance);
  res.json({ success: true, message: `Attendance marked ${status} for ${students[cleanUsn].name} (Period ${period}, ${date})` });
});

// 4. Expose student descriptors (Public)
app.get('/api/public-descriptors', async (req, res) => {
  const students = await db.getStudents();
  const publicData = Object.values(students).map(s => ({
    usn: s.usn,
    name: s.name,
    descriptor: s.descriptor
  }));
  res.json(publicData);
});

// 5. Register Student (Public)
app.post('/api/students', async (req, res) => {
  const { name, usn, email, phone, descriptor } = req.body;

  if (!name || !usn || !email || !phone || !descriptor) {
    return res.status(400).json({ error: 'All registration parameters are required (name, usn, email, phone, face descriptor)' });
  }

  const students = await db.getStudents();
  const cleanUsn = usn.trim().toUpperCase();

  if (students[cleanUsn]) {
    return res.status(400).json({ error: `Student with USN ${cleanUsn} is already registered.` });
  }

  const cleanedPhone = cleanIndianPhoneNumber(phone);
  if (cleanedPhone.length !== 12) {
    return res.status(400).json({ error: 'Please enter a valid 10-digit Indian phone number (with optional +91 prefix).' });
  }

  students[cleanUsn] = {
    name: name.trim(),
    usn: cleanUsn,
    email: email.trim().toLowerCase(),
    phone: '+' + cleanedPhone,
    descriptor: descriptor
  };

  await db.saveStudents(students);
  res.json({ success: true, message: `Student ${name} (${cleanUsn}) registered successfully!` });
});

// 6. Get Student Directory (Protected)
app.get('/api/students', requireFaculty, async (req, res) => {
  const students = await db.getStudents();
  const sortedStudents = Object.values(students).sort((a, b) => a.usn.localeCompare(b.usn));
  res.json(sortedStudents);
});

// 7. Delete Student (Protected)
app.delete('/api/students/:usn', requireFaculty, async (req, res) => {
  const usn = req.params.usn.trim().toUpperCase();
  const students = await db.getStudents();

  if (!students[usn]) {
    return res.status(404).json({ error: `Student with USN ${usn} not found.` });
  }

  const studentName = students[usn].name;
  delete students[usn];
  await db.saveStudents(students);

  const attendance = await db.getAttendance();
  const updatedAttendance = attendance.filter(log => log.usn !== usn);
  await db.saveAttendance(updatedAttendance);

  res.json({ success: true, message: `Student ${studentName} (${usn}) and their history have been successfully deleted.` });
});

// 8. Get Attendance Logs (Protected)
app.get('/api/attendance', requireFaculty, async (req, res) => {
  const { date } = req.query;
  const attendance = await db.getAttendance();

  if (date) {
    const filtered = attendance.filter(log => log.date === date);
    return res.json(filtered);
  }

  res.json(attendance);
});

// 9. Get Analytics & Attendance Percentages (Protected)
app.get('/api/analytics', requireFaculty, async (req, res) => {
  try {
    const stats = await calculateStats();
    res.json(stats);
  } catch (error) {
    console.error('Error computing analytics:', error);
    res.status(500).json({ error: 'Failed to compute attendance analytics.' });
  }
});

// 10. Get Email Outbox Logs (Protected)
app.get('/api/emails', requireFaculty, async (req, res) => {
  res.json(await db.getEmails());
});

// 10b. Get SMS Outbox Logs (Protected)
app.get('/api/sms', requireFaculty, async (req, res) => {
  res.json(await db.getSms());
});

// 11. Simulate EOD 5:00 PM Job immediately (Protected)
app.post('/api/simulate-eod', requireFaculty, async (req, res) => {
  const { date } = req.body;
  const targetDate = date || getAsiaKolkataTimeDetails().dateStr;

  try {
    console.log(`[Simulator] Starting manual EOD email job for ${targetDate}...`);
    const results = await triggerAbsenteeEmailJob(targetDate);
    res.json({
      success: true,
      message: `Successfully executed EOD notification scan for ${targetDate}.`,
      processedCount: results.length,
      recipients: results
    });
  } catch (error) {
    console.error('EOD email simulation failed:', error);
    res.status(500).json({ error: `EOD notification simulation failed: ${error.message}` });
  }
});

// 12. Warn all defaulters via email (Protected)
app.post('/api/warn-defaulters', requireFaculty, async (req, res) => {
  try {
    const stats = await calculateStats();
    const defaulters = stats.students.filter(s => s.attendancePercentage < 75.0);
    const transporter = getMailTransporter();
    const emails = await db.getEmails();
    const results = [];

    for (const student of defaulters) {
      const warningColor = '#d32f2f';
      const emailSubject = `CRITICAL WARNING: Attendance Defaulter Alert - ${student.usn}`;
      
      const emailHtml = `
        <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: auto; padding: 25px; border: 1px solid #e0e0e0; border-radius: 12px; background-color: #ffffff; color: #333333; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
          <div style="text-align: center; padding-bottom: 15px; border-bottom: 2px solid #ef5350;">
            <h2 style="color: #d32f2f; margin: 0; font-size: 24px; letter-spacing: 0.5px;">Academic Defaulter Warning Notice</h2>
            <p style="margin: 5px 0 0 0; color: #777; font-size: 14px;">Aegis AI Attendance Monitor Desk</p>
          </div>
          
          <div style="padding: 20px 0;">
            <p style="font-size: 16px; margin-top: 0;">Dear <strong>${student.name}</strong> (${student.usn}),</p>
            <p style="font-size: 14px; line-height: 1.6; color: #555;">
              This is an official warning that your cumulative academic attendance rate is currently **${student.attendancePercentage}%**, which is **BELOW** the required **75%** threshold.
            </p>
            
            <div style="background-color: #fafafa; padding: 20px; border-radius: 8px; border-left: 5px solid ${warningColor}; margin-top: 20px;">
              <h4 style="margin: 0 0 10px 0; color: #444; font-size: 15px;">Attendance Record Summary</h4>
              <p style="margin: 0; font-size: 14px;">
                <strong>Classes Attended:</strong> ${student.attendedCount}<br>
                <strong>Classes Evaluated:</strong> ${student.totalEvaluatedCount}<br>
                <strong>Current Percentage:</strong> <span style="color: ${warningColor}; font-weight: 700;">${student.attendancePercentage}%</span>
              </p>
            </div>

            <p style="font-size: 13.5px; line-height: 1.6; color: #d32f2f; font-weight: 600; margin-top: 20px;">
              CRITICAL: Failure to raise your attendance percentage to at least 75% before the final examinations will disqualify you from sitting for the examinations under Visvesvaraya Technological University (VTU) regulations.
            </p>
          </div>
          
          <div style="border-top: 1px solid #e0e0e0; padding-top: 15px; text-align: center; font-size: 12px; color: #999;">
            <p style="margin: 0;">This is an automated warning alert sent by the department mentor desk.</p>
            <p style="margin: 5px 0 0 0;">Please meet your department head immediately to address this shortfall.</p>
          </div>
        </div>
      `;

      let mailStatus = 'Simulated (Log Saved)';
      if (transporter) {
        try {
          await transporter.sendMail({
            from: `"Department Mentor Desk" <${process.env.SMTP_USER}>`,
            to: student.email,
            subject: emailSubject,
            html: emailHtml
          });
          mailStatus = 'Sent Successfully';
        } catch (error) {
          console.error(`Failed to send warning email to ${student.email}:`, error);
          mailStatus = `Error Sending: ${error.message}`;
        }
      }

      // Record Email in database
      const emailRecord = {
        id: `email_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        to: student.email,
        studentName: student.name,
        usn: student.usn,
        date: new Date().toISOString().split('T')[0],
        subject: emailSubject,
        body: emailHtml,
        timestamp: new Date().toISOString(),
        status: mailStatus
      };
      emails.unshift(emailRecord);
      results.push({ usn: student.usn, name: student.name, email: student.email, status: mailStatus });
    }

    await db.saveEmails(emails);
    res.json({ success: true, warnedCount: results.length, warnedList: results });
  } catch (error) {
    console.error('Warn defaulters failed:', error);
    res.status(500).json({ error: `Warning job failed: ${error.message}` });
  }
});

app.listen(PORT, () => {
  console.log(`================================================================`);
  console.log(` AI STUDENT ATTENDANCE MONITOR SERVER RUNNING ON PORT ${PORT}`);
  console.log(` Local URL: http://localhost:${PORT}`);
  console.log(` EOD Scheduler: Daily at 5:00 PM (17:00) IST`);
  console.log(`================================================================`);
});

module.exports = app;
