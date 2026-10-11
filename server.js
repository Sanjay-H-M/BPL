require('dotenv').config()

const http = require('http')
const path = require('path')
const express = require('express')
const mongoose = require('mongoose')
const session = require('express-session')
const MongoStore = require('connect-mongo')
const bcrypt = require('bcryptjs')
const helmet = require('helmet')
const { Server } = require('socket.io')

const app = express()

// Fix secure session cookies behind Render's HTTPS proxy.
app.set('trust proxy', 1)

const server = http.createServer(app)
const io = new Server(server, { cors: { origin: false } })
const PORT = Number(process.env.PORT || 3000)

if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  console.warn('WARNING: Set SESSION_SECRET in your production environment.')
}

// ============================================================
// MONGOOSE SCHEMAS
// ============================================================

const teamSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, unique: true },
    logo: String,
    captain: String,
    color: { type: String, default: '#16a34a' }
  },
  { timestamps: true }
)

const playerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    jerseyNumber: { type: Number, min: 0, max: 999 },
    role: {
      type: String,
      enum: ['Batter', 'Bowler', 'All-rounder', 'Wicketkeeper'],
      default: 'Batter'
    },
    team: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Team',
      required: true
    },
    active: { type: Boolean, default: true }
  },
  { timestamps: true }
)

const deliverySchema = new mongoose.Schema(
  {
    sequence: Number,
    batter: String,
    bowler: String,
    runs: { type: Number, default: 0 },
    batterRuns: { type: Number, default: 0 },
    extras: { type: Number, default: 0 },
    extraType: { type: String, default: '' },
    legal: { type: Boolean, default: true },
    wicket: { type: Boolean, default: false },
    dismissal: String,
    dismissedPlayer: String,
    note: String,
    createdAt: { type: Date, default: Date.now }
  },
  { _id: true }
)

const inningsSchema = new mongoose.Schema({
  number: Number,
  battingTeam: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Team'
  },
  bowlingTeam: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Team'
  },
  total: { type: Number, default: 0 },
  wickets: { type: Number, default: 0 },
  legalBalls: { type: Number, default: 0 },
  extras: { type: Number, default: 0 },
  deliveries: [deliverySchema],
  striker: String,
  nonStriker: String,
  bowler: String,
  status: { type: String, default: 'Not Started' },
  battingStats: { type: mongoose.Schema.Types.Mixed, default: {} },
  bowlingStats: { type: mongoose.Schema.Types.Mixed, default: {} }
})

const matchSchema = new mongoose.Schema(
  {
    teamA: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Team',
      required: true
    },
    teamB: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Team',
      required: true
    },
    date: { type: Date, required: true },
    venue: String,
    oversPerInnings: { type: Number, default: 20, min: 1, max: 50 },
    stage: { type: String, default: 'League' },
    status: {
      type: String,
      enum: [
        'Scheduled',
        'Live',
        'Innings Break',
        'Paused',
        'Completed',
        'Postponed',
        'Cancelled',
        'Abandoned'
      ],
      default: 'Scheduled'
    },
    tossWinner: String,
    tossDecision: String,
    result: String,
    winner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Team'
    },
    innings: [inningsSchema],
    pointsOverride: String
  },
  { timestamps: true }
)

const adminSchema = new mongoose.Schema({
  username: { type: String, unique: true },
  passwordHash: String,
  role: { type: String, default: 'admin' }
})

const settingSchema = new mongoose.Schema({
  key: { type: String, unique: true },
  value: mongoose.Schema.Types.Mixed
})

const Team = mongoose.model('Team', teamSchema)
const Player = mongoose.model('Player', playerSchema)
const Match = mongoose.model('Match', matchSchema)
const Admin = mongoose.model('Admin', adminSchema)
const Setting = mongoose.model('Setting', settingSchema)

// ============================================================
// MIDDLEWARE
// ============================================================

app.use(helmet({ contentSecurityPolicy: false }))
app.use(express.json({ limit: '1mb' }))
app.use(express.urlencoded({ extended: false }))

app.use(
  session({
    name: 'bpl.sid',
    secret:
      process.env.SESSION_SECRET ||
      'development-only-change-this-secret',
    resave: false,
    saveUninitialized: false,
    store: process.env.MONGODB_URI
      ? MongoStore.create({ mongoUrl: process.env.MONGODB_URI })
      : undefined,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 8
    }
  })
)

app.use(express.static(path.join(__dirname, 'public')))

const asyncRoute = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next)

const adminOnly = (req, res, next) =>
  req.session?.admin
    ? next()
    : res.status(401).json({ error: 'Admin login required.' })

const clean = (s) => String(s || '').trim()

function publish(event = 'data:changed') {
  io.emit(event, { at: Date.now() })
  io.emit('data:changed', { at: Date.now() })
}

function overText(balls) {
  return `${Math.floor(balls / 6)}.${balls % 6}`
}

function summarizeInnings(i) {
  return {
    ...i.toObject(),
    overs: overText(i.legalBalls || 0),
    runRate: i.legalBalls
      ? +(i.total / (i.legalBalls / 6)).toFixed(2)
      : 0
  }
}

async function publicMatch(m) {
  const obj = m.toObject()

  const [a, b] = await Promise.all([
    Team.findById(m.teamA).lean(),
    Team.findById(m.teamB).lean()
  ])

  obj.teamA = a
  obj.teamB = b
  obj.innings = (m.innings || []).map(summarizeInnings)

  if (obj.winner) {
    obj.winner = await Team.findById(obj.winner).lean()
  }

  return obj
}

// ============================================================
// PUBLIC API
// ============================================================

app.get(
  '/api/public/overview',
  asyncRoute(async (req, res) => {
    const [teams, players, matches] = await Promise.all([
      Team.find().lean(),
      Player.find().populate('team', 'name').lean(),
      Match.find().sort({ date: 1 }).lean()
    ])

    const live = matches.filter((m) =>
      ['Live', 'Innings Break', 'Paused'].includes(m.status)
    )

    const upcoming = matches.filter((m) =>
      ['Scheduled', 'Postponed'].includes(m.status)
    )

    const completed = matches.filter((m) =>
      ['Completed', 'Abandoned', 'Cancelled'].includes(m.status)
    )

    const hydrated = await Promise.all(
      matches.map(async (m) =>
        publicMatch(await Match.findById(m._id))
      )
    )

    const rules = await Setting.findOne({ key: 'rules' }).lean()

    res.json({
      stats: {
        teams: teams.length,
        players: players.length,
        live: live.length,
        upcoming: upcoming.length
      },
      teams,
      players,
      matches: hydrated,
      rules: rules?.value || {
        win: 2,
        tie: 1,
        noResult: 1,
        loss: 0
      }
    })
  })
)

app.get(
  '/api/public/teams',
  asyncRoute(async (req, res) => {
    res.json(await Team.find().lean())
  })
)

app.get(
  '/api/public/matches/:id',
  asyncRoute(async (req, res) => {
    const m = await Match.findById(req.params.id)

    if (!m) {
      return res.status(404).json({ error: 'Match not found' })
    }

    res.json(await publicMatch(m))
  })
)

app.get(
  '/api/public/standings',
  asyncRoute(async (req, res) => {
    const teams = await Team.find().lean()
    const matches = await Match.find({ status: 'Completed' }).lean()

    const table = teams.map((t) => ({
      _id: t._id,
      name: t.name,
      played: 0,
      won: 0,
      lost: 0,
      tied: 0,
      noResult: 0,
      points: 0,
      runsFor: 0,
      ballsFor: 0,
      runsAgainst: 0,
      ballsAgainst: 0,
      nrr: 0
    }))

    const byId = Object.fromEntries(
      table.map((t) => [String(t._id), t])
    )

    for (const m of matches) {
      const a = byId[String(m.teamA)]
      const b = byId[String(m.teamB)]

      if (!a || !b) continue

      a.played++
      b.played++

      for (const inn of m.innings || []) {
        const bat = byId[String(inn.battingTeam)]
        const bowl = byId[String(inn.bowlingTeam)]

        if (!bat || !bowl) continue

        bat.runsFor += inn.total || 0
        bat.ballsFor += inn.legalBalls || 0
        bowl.runsAgainst += inn.total || 0
        bowl.ballsAgainst += inn.legalBalls || 0
      }

      if (m.winner) {
        const w = byId[String(m.winner)]
        const l = w === a ? b : a

        if (w) {
          w.won++
          w.points += 2
        }

        if (l) l.lost++
      } else if (m.result && /tie/i.test(m.result)) {
        a.tied++
        b.tied++
        a.points++
        b.points++
      } else {
        a.noResult++
        b.noResult++
        a.points++
        b.points++
      }
    }

    table.forEach((t) => {
      const forRate = t.ballsFor
        ? t.runsFor / (t.ballsFor / 6)
        : 0

      const againstRate = t.ballsAgainst
        ? t.runsAgainst / (t.ballsAgainst / 6)
        : 0

      t.nrr = +(forRate - againstRate).toFixed(3)

      delete t.runsFor
      delete t.ballsFor
      delete t.runsAgainst
      delete t.ballsAgainst
    })

    table.sort(
      (a, b) =>
        b.points - a.points ||
        b.nrr - a.nrr ||
        a.name.localeCompare(b.name)
    )

    table.forEach((t, i) => {
      t.position = i + 1
    })

    res.json(table)
  })
)

// ============================================================
// ADMIN AUTHENTICATION
// ============================================================

app.post(
  '/api/auth/login',
  asyncRoute(async (req, res) => {
    const username = clean(req.body.username)
    const password = String(req.body.password || '')

    let admin = await Admin.findOne({ username })

    // Create the initial admin account from Render environment variables.
    if (
      !admin &&
      process.env.ADMIN_USERNAME &&
      username === process.env.ADMIN_USERNAME &&
      password === process.env.ADMIN_PASSWORD
    ) {
      const passwordHash = await bcrypt.hash(password, 12)

      admin = await Admin.create({
        username,
        passwordHash,
        role: 'admin'
      })
    }

    if (
      !admin ||
      !(await bcrypt.compare(password, admin.passwordHash))
    ) {
      return res.status(401).json({
        error: 'Invalid username or password.'
      })
    }

    req.session.admin = {
      id: String(admin._id),
      username: admin.username,
      role: admin.role
    }

    // Save the session before returning the successful login response.
    req.session.save((err) => {
      if (err) {
        console.error('Session save failed:', err)
        return res.status(500).json({
          error: 'Could not create login session.'
        })
      }

      res.json({ username: admin.username })
    })
  })
)

app.get('/api/auth/me', (req, res) => {
  res.json({
    authenticated: !!req.session?.admin,
    admin: req.session?.admin || null
  })
})

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({
        error: 'Could not log out.'
      })
    }

    res.clearCookie('bpl.sid', {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production'
    })

    res.json({ ok: true })
  })
})

// ============================================================
// ADMIN OVERVIEW
// ============================================================

app.get(
  '/api/admin/overview',
  adminOnly,
  asyncRoute(async (req, res) => {
    const [teams, players, matches] = await Promise.all([
      Team.countDocuments(),
      Player.countDocuments(),
      Match.find()
        .sort({ updatedAt: -1 })
        .limit(8)
        .populate('teamA teamB')
        .lean()
    ])

    res.json({
      teams,
      players,
      live: matches.filter((m) => m.status === 'Live').length,
      upcoming: await Match.countDocuments({
        status: 'Scheduled'
      }),
      recent: matches
    })
  })
)

// ============================================================
// TEAM MANAGEMENT
// ============================================================

app.get(
  '/api/admin/teams',
  adminOnly,
  asyncRoute(async (req, res) => {
    res.json(await Team.find().sort('name').lean())
  })
)

app.post(
  '/api/admin/teams',
  adminOnly,
  asyncRoute(async (req, res) => {
    const name = clean(req.body.name)

    if (!name) {
      return res.status(400).json({
        error: 'Team name is required.'
      })
    }

    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

    const duplicate = await Team.findOne({
      name: {
        $regex: '^' + escapedName + '$',
        $options: 'i'
      }
    }).lean()

    if (duplicate) {
      return res.status(409).json({
        error: `A team named "${duplicate.name}" already exists. Enter a different team name.`
      })
    }

    const t = await Team.create({
      name,
      logo: clean(req.body.logo),
      captain: clean(req.body.captain),
      color: req.body.color || '#16a34a'
    })

    publish()
    res.status(201).json(t)
  })
)

app.put(
  '/api/admin/teams/:id',
  adminOnly,
  asyncRoute(async (req, res) => {
    const name = clean(req.body.name)

    if (!name) {
      return res.status(400).json({
        error: 'Team name is required.'
      })
    }

    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

    const duplicate = await Team.findOne({
      _id: { $ne: req.params.id },
      name: {
        $regex: '^' + escapedName + '$',
        $options: 'i'
      }
    }).lean()

    if (duplicate) {
      return res.status(409).json({
        error: `A team named "${duplicate.name}" already exists. Enter a different team name.`
      })
    }

    const t = await Team.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          name,
          logo: clean(req.body.logo),
          captain: clean(req.body.captain),
          color: req.body.color || '#16a34a'
        }
      },
      { new: true, runValidators: true }
    )

    if (!t) {
      return res.status(404).json({
        error: 'Team not found.'
      })
    }

    publish()
    res.json(t)
  })
)

app.delete(
  '/api/admin/teams/:id',
  adminOnly,
  asyncRoute(async (req, res) => {
    const linked = await Match.countDocuments({
      $or: [
        { teamA: req.params.id },
        { teamB: req.params.id }
      ]
    })

    if (linked) {
      return res.status(409).json({
        error:
          'This team has match history. Remove or reassign its fixtures first.'
      })
    }

    await Player.deleteMany({ team: req.params.id })

    const t = await Team.findByIdAndDelete(req.params.id)

    if (!t) {
      return res.status(404).json({
        error: 'Team not found.'
      })
    }

    publish()
    res.json({ ok: true })
  })
)

// ============================================================
// PLAYER MANAGEMENT
// ============================================================

app.get(
  '/api/admin/players',
  adminOnly,
  asyncRoute(async (req, res) => {
    res.json(
      await Player.find()
        .populate('team', 'name')
        .sort('name')
        .lean()
    )
  })
)

app.post(
  '/api/admin/players',
  adminOnly,
  asyncRoute(async (req, res) => {
    if (!clean(req.body.name) || !req.body.team) {
      return res.status(400).json({
        error: 'Player name and team are required.'
      })
    }

    if (
      req.body.jerseyNumber !== '' &&
      req.body.jerseyNumber != null
    ) {
      const duplicate = await Player.findOne({
        team: req.body.team,
        jerseyNumber: Number(req.body.jerseyNumber)
      })

      if (duplicate) {
        return res.status(409).json({
          error: 'That jersey number is already used in this team.'
        })
      }
    }

    const p = await Player.create({
      name: clean(req.body.name),
      team: req.body.team,
      jerseyNumber:
        req.body.jerseyNumber === ''
          ? undefined
          : req.body.jerseyNumber,
      role: req.body.role || 'Batter'
    })

    publish()
    res.status(201).json(await p.populate('team', 'name'))
  })
)

app.put(
  '/api/admin/players/:id',
  adminOnly,
  asyncRoute(async (req, res) => {
    const p = await Player.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          name: clean(req.body.name),
          team: req.body.team,
          jerseyNumber:
            req.body.jerseyNumber === ''
              ? undefined
              : req.body.jerseyNumber,
          role: req.body.role || 'Batter'
        }
      },
      { new: true, runValidators: true }
    ).populate('team', 'name')

    if (!p) {
      return res.status(404).json({
        error: 'Player not found.'
      })
    }

    publish()
    res.json(p)
  })
)

app.delete(
  '/api/admin/players/:id',
  adminOnly,
  asyncRoute(async (req, res) => {
    const p = await Player.findByIdAndDelete(req.params.id)

    if (!p) {
      return res.status(404).json({
        error: 'Player not found.'
      })
    }

    publish()
    res.json({ ok: true })
  })
)

// ============================================================
// MATCH MANAGEMENT
// ============================================================

app.get(
  '/api/admin/matches',
  adminOnly,
  asyncRoute(async (req, res) => {
    const matches = await Match.find().sort({ date: -1 })

    res.json(await Promise.all(matches.map(publicMatch)))
  })
)

app.post(
  '/api/admin/matches',
  adminOnly,
  asyncRoute(async (req, res) => {
    const { teamA, teamB, date } = req.body

    if (
      !teamA ||
      !teamB ||
      String(teamA) === String(teamB) ||
      !date
    ) {
      return res.status(400).json({
        error: 'Choose two different teams and a valid date.'
      })
    }

    const [a, b] = await Promise.all([
      Team.findById(teamA),
      Team.findById(teamB)
    ])

    if (!a || !b) {
      return res.status(400).json({
        error: 'Both teams must exist.'
      })
    }

    const matchDate = new Date(date)

    if (Number.isNaN(matchDate.getTime())) {
      return res.status(400).json({
        error: 'Invalid date.'
      })
    }

    const conflict = await Match.findOne({
      status: { $in: ['Scheduled', 'Live'] },
      date: {
        $gte: new Date(matchDate.getTime() - 3 * 3600000),
        $lte: new Date(matchDate.getTime() + 3 * 3600000)
      },
      $or: [
        { teamA },
        { teamB },
        { teamA: teamB },
        { teamB: teamA }
      ]
    })

    if (conflict) {
      return res.status(409).json({
        error: 'Schedule conflict: a team already has a nearby fixture.'
      })
    }

    const m = await Match.create({
      teamA,
      teamB,
      date: matchDate,
      venue: clean(req.body.venue),
      oversPerInnings: Number(req.body.oversPerInnings) || 20,
      stage: clean(req.body.stage) || 'League'
    })

    publish()
    res.status(201).json(await publicMatch(m))
  })
)

app.put(
  '/api/admin/matches/:id',
  adminOnly,
  asyncRoute(async (req, res) => {
    const allowed = [
      'date',
      'venue',
      'oversPerInnings',
      'stage',
      'status',
      'tossWinner',
      'tossDecision',
      'result',
      'winner'
    ]

    const set = {}

    for (const k of allowed) {
      if (req.body[k] !== undefined) set[k] = req.body[k]
    }

    if (set.date) set.date = new Date(set.date)

    const m = await Match.findByIdAndUpdate(
      req.params.id,
      { $set: set },
      { new: true, runValidators: true }
    )

    if (!m) {
      return res.status(404).json({
        error: 'Match not found.'
      })
    }

    publish()
    res.json(await publicMatch(m))
  })
)

app.delete(
  '/api/admin/matches/:id',
  adminOnly,
  asyncRoute(async (req, res) => {
    const m = await Match.findByIdAndDelete(req.params.id)

    if (!m) {
      return res.status(404).json({
        error: 'Match not found.'
      })
    }

    publish()
    res.json({ ok: true })
  })
)

// ============================================================
// LIVE MATCH AND SCORING
// ============================================================

app.post(
  '/api/admin/matches/:id/start',
  adminOnly,
  asyncRoute(async (req, res) => {
    const m = await Match.findById(req.params.id)

    if (!m) {
      return res.status(404).json({
        error: 'Match not found.'
      })
    }

    if (m.status === 'Completed') {
      return res.status(409).json({
        error: 'Completed match cannot be started again.'
      })
    }

    m.status = 'Live'

    if (!m.innings.length) {
      m.innings.push({
        number: 1,
        battingTeam: m.teamA,
        bowlingTeam: m.teamB,
        status: 'Live'
      })
    } else {
      m.innings[m.innings.length - 1].status = 'Live'
    }

    await m.save()
    publish()
    res.json(await publicMatch(m))
  })
)

app.post(
  '/api/admin/matches/:id/score',
  adminOnly,
  asyncRoute(async (req, res) => {
    const m = await Match.findById(req.params.id)

    if (!m) {
      return res.status(404).json({
        error: 'Match not found.'
      })
    }

    if (!['Live', 'Paused'].includes(m.status)) {
      return res.status(409).json({
        error: 'Match must be live or paused to score.'
      })
    }

    const inn = m.innings[m.innings.length - 1]

    if (!inn) {
      return res.status(409).json({
        error: 'Start the match before scoring.'
      })
    }

    if (req.body.striker !== undefined) {
      inn.striker = clean(req.body.striker)
    }

    if (req.body.nonStriker !== undefined) {
      inn.nonStriker = clean(req.body.nonStriker)
    }

    if (req.body.bowler !== undefined) {
      inn.bowler = clean(req.body.bowler)
    }

    const type = String(req.body.type || 'runs')
    const amount = Number(req.body.runs || 0)

    if (!Number.isInteger(amount) || amount < 0 || amount > 7) {
      return res.status(400).json({
        error: 'Runs must be an integer from 0 to 7.'
      })
    }

    if (type === 'undo') {
      if (!inn.deliveries.length) {
        return res.status(409).json({
          error: 'No delivery to undo.'
        })
      }

      inn.deliveries.pop()
      recalculate(inn)
      await m.save()
      publish('score:changed')

      return res.json(await publicMatch(m))
    }

    if (type === 'wicket' && !clean(req.body.dismissal)) {
      return res.status(400).json({
        error: 'Select a dismissal type.'
      })
    }

    const extraType = [
      'wide',
      'no-ball',
      'bye',
      'leg-bye',
      'penalty'
    ].includes(type)
      ? type
      : ''

    const legal = !['wide', 'no-ball', 'penalty'].includes(type)

    const batterRuns =
      type === 'runs'
        ? amount
        : type === 'no-ball'
          ? amount
          : 0

    const extras =
      type === 'wide'
        ? 1 + amount
        : type === 'no-ball'
          ? 1
          : type === 'bye' || type === 'leg-bye'
            ? amount
            : type === 'penalty'
              ? amount
              : 0

    const total =
      type === 'wicket'
        ? 0
        : type === 'wide'
          ? 1 + amount
          : type === 'no-ball'
            ? 1 + amount
            : type === 'penalty'
              ? amount
              : type === 'bye' || type === 'leg-bye'
                ? amount
                : amount

    const delivery = {
      sequence: inn.deliveries.length + 1,
      batter: clean(req.body.batter || inn.striker),
      bowler: clean(req.body.bowler || inn.bowler),
      runs: total,
      batterRuns,
      extras,
      extraType,
      legal,
      wicket: type === 'wicket',
      dismissal: clean(req.body.dismissal),
      dismissedPlayer: clean(req.body.dismissedPlayer || inn.striker),
      note: clean(req.body.note)
    }

    inn.deliveries.push(delivery)
    recalculate(inn)

    if (type === 'wicket' && delivery.dismissedPlayer) {
      if (inn.striker === delivery.dismissedPlayer) inn.striker = ''
      if (inn.nonStriker === delivery.dismissedPlayer) {
        inn.nonStriker = ''
      }
    }

    if (legal && total % 2 === 1 && type !== 'wicket') {
      const s = inn.striker
      inn.striker = inn.nonStriker
      inn.nonStriker = s
    }

    if (inn.legalBalls > 0 && inn.legalBalls % 6 === 0) {
      const s = inn.striker
      inn.striker = inn.nonStriker
      inn.nonStriker = s
    }

    const maxBalls = Number(m.oversPerInnings || 20) * 6

    if (inn.legalBalls >= maxBalls || inn.wickets >= 10) {
      inn.status = 'Completed'

      if (m.innings.length === 1) {
        m.status = 'Innings Break'
      } else {
        m.status = 'Completed'
        m.result =
          inn.total >= m.innings[0].total + 1
            ? 'Chase completed'
            : inn.total === m.innings[0].total
              ? 'Match tied'
              : 'Innings completed'
      }
    }

    if (
      m.innings.length === 2 &&
      inn.total >= m.innings[0].total + 1
    ) {
      inn.status = 'Completed'
      m.status = 'Completed'
      m.result = 'Target reached'
    }

    await m.save()
    publish('score:changed')
    res.json(await publicMatch(m))
  })
)

app.post(
  '/api/admin/matches/:id/innings',
  adminOnly,
  asyncRoute(async (req, res) => {
    const m = await Match.findById(req.params.id)

    if (!m) {
      return res.status(404).json({
        error: 'Match not found.'
      })
    }

    if (m.innings.length >= 2) {
      return res.status(409).json({
        error: 'Both innings already exist.'
      })
    }

    const first = m.innings[0]

    if (!first || first.status !== 'Completed') {
      return res.status(409).json({
        error: 'Complete the first innings before starting the next.'
      })
    }

    m.innings.push({
      number: 2,
      battingTeam: first.bowlingTeam,
      bowlingTeam: first.battingTeam,
      status: 'Live'
    })

    m.status = 'Live'
    await m.save()
    publish('score:changed')
    res.json(await publicMatch(m))
  })
)

// ============================================================
// MANUAL POINTS TABLE
// ============================================================

app.post(
  '/api/admin/standings/manual',
  adminOnly,
  asyncRoute(async (req, res) => {
    const value = req.body.value

    if (!Array.isArray(value)) {
      return res.status(400).json({
        error: 'Standings must be an array.'
      })
    }

    await Setting.findOneAndUpdate(
      { key: 'manualStandings' },
      {
        $set: {
          value,
          updatedBy: req.session.admin.username,
          reason: clean(req.body.reason)
        }
      },
      { upsert: true, new: true }
    )

    publish()
    res.json({ ok: true })
  })
)

// ============================================================
// SCORE RECALCULATION
// ============================================================

function recalculate(inn) {
  inn.total = 0
  inn.wickets = 0
  inn.legalBalls = 0
  inn.extras = 0

  const batting = {}
  const bowling = {}

  for (const d of inn.deliveries) {
    inn.total += d.runs || 0
    inn.extras += d.extras || 0

    if (d.legal) inn.legalBalls++
    if (d.wicket) inn.wickets++

    if (d.batter) {
      batting[d.batter] ||= {
        runs: 0,
        balls: 0,
        fours: 0,
        sixes: 0
      }

      batting[d.batter].runs += d.batterRuns || 0

      if (d.extraType !== 'wide') {
        batting[d.batter].balls++
      }

      if (d.batterRuns === 4) batting[d.batter].fours++
      if (d.batterRuns === 6) batting[d.batter].sixes++
    }

    if (d.bowler) {
      bowling[d.bowler] ||= {
        runs: 0,
        balls: 0,
        wickets: 0
      }

      bowling[d.bowler].runs += d.runs || 0

      if (d.legal) bowling[d.bowler].balls++

      if (
        d.wicket &&
        ![
          'run out',
          'retired hurt',
          'obstructing the field'
        ].includes((d.dismissal || '').toLowerCase())
      ) {
        bowling[d.bowler].wickets++
      }
    }
  }

  inn.battingStats = batting
  inn.bowlingStats = bowling
}

// ============================================================
// ADMIN PAGE
// ============================================================

app.get('/admin.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'))
})

// ============================================================
// ERROR HANDLING
// ============================================================

app.use((err, req, res, next) => {
  console.error(err)

  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0]
    const value = field ? err.keyValue[field] : ''

    return res.status(409).json({
      error:
        field === 'name'
          ? `A team with the name "${value}" already exists. Please use a different name.`
          : `Duplicate value${
              field ? ` for ${field}` : ''
            }. Please check the entered information.`
    })
  }

  if (
    err.name === 'ValidationError' ||
    err.name === 'CastError'
  ) {
    return res.status(400).json({ error: err.message })
  }

  res.status(500).json({
    error: 'Unexpected server error.'
  })
})

// ============================================================
// DATABASE CONNECTION AND SERVER STARTUP
// ============================================================

mongoose
  .connect(
    process.env.MONGODB_URI ||
      'mongodb://127.0.0.1:27017/bpl'
  )
  .then(async () => {
    // Remove an obsolete unique shortName index left by an older version.
    if (!teamSchema.path('shortName')) {
      try {
        const indexes = await Team.collection.indexes()

        for (const index of indexes) {
          if (
            index.unique &&
            index.key &&
            Object.keys(index.key).length === 1 &&
            index.key.shortName === 1
          ) {
            await Team.collection.dropIndex(index.name)

            console.log(
              `Removed obsolete unique index: ${index.name}`
            )
          }
        }
      } catch (err) {
        console.error(
          'Could not remove obsolete shortName index:',
          err.message
        )

        process.exit(1)
      }
    }

    server.listen(PORT, () => {
      console.log(`BPL running at http://localhost:${PORT}`)
    })
  })
  .catch((err) => {
    console.error('MongoDB connection failed:', err.message)
    process.exit(1)
  })

// ============================================================
// SOCKET.IO
// ============================================================

io.on('connection', (socket) => {
  socket.emit('connected', { ok: true })
})