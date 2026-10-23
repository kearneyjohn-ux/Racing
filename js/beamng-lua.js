// Lua shipped inside the BeamNG mod zip. The extension reads the level's westlime_pacenotes.json
// and, while you drive, shows each corner's call a set distance before it, plus a lap or stage
// timer. Everything is guarded so a missing game function can't break the game.

export const MODSCRIPT_LUA = `-- Race Course Plotter pace notes: start the extension when the game loads mods.
if extensions and extensions.load then
  extensions.load('westlimePacenotes')
elseif load then
  load('westlimePacenotes')
end
if setExtensionUnloadMode then
  setExtensionUnloadMode('westlimePacenotes', 'manual')
end
`;

export const PACENOTES_LUA = `-- Pace notes for courses exported from Race Course Plotter (Westlime Motorsport).
-- Reads /levels/<level>/westlime_pacenotes.json when such a level is loaded; does nothing elsewhere.
local M = {}

local data = nil
local levelSeen = false
local idx = 1
local lastS = nil
local speed = 0
local calledAt = {}
local simClock = 0
local tick = 0
local lapStart = nil

local function say(text, ttl, category)
  if ui_message then
    pcall(ui_message, text, ttl or 4, category or 'westlimePacenotes')
  end
end

local function currentLevel()
  if not getMissionFilename then return nil end
  local ok, f = pcall(getMissionFilename)
  if not ok or type(f) ~= 'string' then return nil end
  return f:match('levels/([^/]+)/')
end

local function loadNotes()
  data = nil
  idx, lastS, speed, calledAt, lapStart = 1, nil, 0, {}, nil
  local lvl = currentLevel()
  levelSeen = lvl
  if not lvl or not jsonReadFile then return end
  local ok, d = pcall(jsonReadFile, '/levels/' .. lvl .. '/westlime_pacenotes.json')
  if ok and type(d) == 'table' and type(d.line) == 'table' and #d.line > 1 then
    d.notes = d.notes or {}
    data = d
    say((d.title or 'Course') .. ': ' .. #d.notes .. ' pace notes loaded', 6)
  end
end

local function nearest(x, y)
  local line = data.line
  local n = #line
  local best, bd = idx, math.huge
  local function try(i)
    local p = line[i]
    local dx, dy = p[1] - x, p[2] - y
    local d = dx * dx + dy * dy
    if d < bd then bd, best = d, i end
  end
  -- Search just around the last position (40 m back, 100 m on) so a course that crosses
  -- itself isn't mistaken for a jump; look everywhere only when that finds nothing close.
  if data.closed then
    for k = idx - 8, idx + 20 do try((k - 1) % n + 1) end
  else
    for i = math.max(1, idx - 8), math.min(n, idx + 20) do try(i) end
  end
  if bd > 3600 then
    for i = 1, n do try(i) end
  end
  return best, math.sqrt(bd)
end

-- Distance along the course at x, y: projected onto the segments either side of point i.
local function progressAt(i, x, y)
  local line = data.line
  local bestS, bd = line[i][3], math.huge
  for j = math.max(1, i - 1), math.min(#line - 1, i) do
    local a, b = line[j], line[j + 1]
    local vx, vy = b[1] - a[1], b[2] - a[2]
    local l2 = vx * vx + vy * vy
    local t = 0
    if l2 > 0 then t = ((x - a[1]) * vx + (y - a[2]) * vy) / l2 end
    if t < 0 then t = 0 elseif t > 1 then t = 1 end
    local px, py = a[1] + vx * t, a[2] + vy * t
    local d = (px - x) ^ 2 + (py - y) ^ 2
    if d < bd then bd, bestS = d, a[3] + (b[3] - a[3]) * t end
  end
  return bestS
end

local function fmtTime(t)
  return string.format('%d:%05.2f', math.floor(t / 60), t % 60)
end

local function callAhead(s)
  local L = data.length
  local lead = data.lead or 100
  if (data.leadSeconds or 0) > 0 then lead = math.max(40, speed * data.leadSeconds) end
  local parts = {}
  local first = nil
  for k, note in ipairs(data.notes) do
    local d = note.s - s
    if data.closed and d < -L / 2 then d = d + L end
    if d >= 0 and d <= lead and (not calledAt[k] or simClock - calledAt[k] > 30) then
      calledAt[k] = simClock
      parts[#parts + 1] = note.text
      if not first then first = d end
    end
  end
  if #parts > 0 then
    say(string.format('%d m  %s', math.floor(first / 10 + 0.5) * 10, table.concat(parts, ', into ')), 4)
  end
end

local function timing(prev, s)
  local L = data.length
  if data.closed then
    -- Crossing the line: distance along the course wraps from the end back to 0.
    if prev - s > L / 2 then
      if lapStart then say('Lap ' .. fmtTime(simClock - lapStart), 10, 'westlimeTiming') end
      lapStart = simClock
    end
  else
    local start = data.start or 0
    if prev < start and s >= start then
      lapStart = simClock
      say('Go', 2, 'westlimeTiming')
    end
    if lapStart and prev < L - 5 and s >= L - 5 then
      say('Stage ' .. fmtTime(simClock - lapStart), 12, 'westlimeTiming')
      lapStart = nil
    end
  end
end

local function update(dtReal, dtSim)
  simClock = simClock + (dtSim or 0)
  tick = tick + (dtReal or 0)
  if tick < 0.1 then return end
  local dt = tick
  tick = 0
  if currentLevel() ~= levelSeen then loadNotes() end
  if not data or not be then return end
  local veh = be:getPlayerVehicle(0)
  if not veh then return end
  local pos = veh:getPosition()
  local i, off = nearest(pos.x, pos.y)
  idx = i
  if off > 40 then
    lastS = nil
    return
  end
  local s = progressAt(i, pos.x, pos.y)
  if lastS then
    local L = data.length
    local ds = s - lastS
    if data.closed then
      if ds < -L / 2 then ds = ds + L elseif ds > L / 2 then ds = ds - L end
    end
    if ds < -20 or ds > 200 then
      -- Reset or teleport: start the calls afresh.
      calledAt = {}
      lapStart = nil
    else
      speed = speed * 0.6 + (ds / dt) * 0.4
      if ds > 0 and speed > 1 then
        callAhead(s)
        timing(lastS, s)
      end
    end
  end
  lastS = s
end

function M.onUpdate(dtReal, dtSim, dtRaw)
  local ok, err = pcall(update, dtReal, dtSim)
  if not ok and log then
    log('E', 'westlimePacenotes', tostring(err))
    data = nil
  end
end

function M.onClientPostStartMission()
  pcall(loadNotes)
end

function M.onExtensionLoaded()
  pcall(loadNotes)
end

return M
`;
