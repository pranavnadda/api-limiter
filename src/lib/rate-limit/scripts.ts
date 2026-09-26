/**
 * Redis scripts. Fixed-window commits with INCR and PEXPIRE inside one EVAL
 * so a multi-window deny writes nothing. The TypeScript twin lives in atomic.ts.
 */

export const CONSUME_ALL_LUA = `
local now = tonumber(ARGV[1])
local specs = cjson.decode(ARGV[2])
local dry = ARGV[3] == "1"
local planned = {}
local denied = false

for i, spec in ipairs(specs) do
  local key = KEYS[i]
  local algorithm = spec.algorithm
  local limit = tonumber(spec.limit)
  local windowMs = tonumber(spec.windowMs)
  local entry = { limit = limit, key = key }

  if algorithm == "fixed-window" then
    local count = tonumber(redis.call("GET", key) or "0")
    local nextCount = count + 1
    local allowed = nextCount <= limit
    entry.kind = "fixed"
    entry.allowed = allowed
    entry.count = allowed and nextCount or count
    entry.remaining = allowed and math.max(0, limit - nextCount) or 0
    entry.resetTime = tonumber(spec.resetTime)
    entry.ttl = tonumber(spec.ttlMs)
  elseif algorithm == "token-bucket" then
    local refill = tonumber(spec.refillRate)
    local raw = redis.call("GET", key)
    local tokens = limit
    local lastRefill = now
    if raw then
      local state = cjson.decode(raw)
      local elapsed = math.max(0, (now - tonumber(state.lastRefill)) / 1000)
      tokens = math.min(limit, tonumber(state.tokens) + elapsed * refill)
      lastRefill = now
    end
    local allowed = tokens >= 1
    local stored = tokens
    if allowed then stored = tokens - 1 end
    local resetIn
    if allowed then
      if refill > 0 then
        resetIn = math.ceil((1 / refill) * 1000)
      else
        resetIn = windowMs
      end
    else
      local need = math.max(0, 1 - stored)
      if refill > 0 then
        resetIn = math.ceil((need / refill) * 1000)
      else
        resetIn = windowMs
      end
    end
    entry.kind = "token"
    entry.allowed = allowed
    entry.count = math.ceil(limit - stored)
    entry.remaining = math.max(0, math.floor(stored))
    entry.resetTime = now + resetIn
    entry.tokens = stored
    entry.lastRefill = lastRefill
    entry.idleTtl = tonumber(spec.idleTtlMs)
  else
    local cutoff = now - windowMs
    local raw = redis.call("GET", key)
    local timestamps = {}
    if raw then
      local state = cjson.decode(raw)
      if state.timestamps then
        for _, t in ipairs(state.timestamps) do
          if tonumber(t) > cutoff then
            table.insert(timestamps, tonumber(t))
          end
        end
      end
    end
    local allowed = #timestamps < limit
    if allowed then
      table.insert(timestamps, now)
    end
    local oldest = timestamps[1] or now
    entry.kind = "sliding"
    entry.allowed = allowed
    entry.count = #timestamps
    entry.remaining = allowed and math.max(0, limit - #timestamps) or 0
    entry.resetTime = oldest + windowMs
    entry.timestamps = timestamps
    entry.windowMs = windowMs
  end

  if not entry.allowed then denied = true end
  planned[i] = entry
end

if (not denied) and (not dry) then
  for _, entry in ipairs(planned) do
    if entry.kind == "fixed" then
      redis.call("INCR", entry.key)
      local pttl = redis.call("PTTL", entry.key)
      if pttl < 0 then
        redis.call("PEXPIRE", entry.key, entry.ttl)
      end
    elseif entry.kind == "token" then
      redis.call(
        "SET",
        entry.key,
        cjson.encode({ tokens = entry.tokens, lastRefill = entry.lastRefill }),
        "PX",
        entry.idleTtl
      )
    else
      redis.call(
        "SET",
        entry.key,
        cjson.encode({ timestamps = entry.timestamps, windowMs = entry.windowMs }),
        "PX",
        entry.windowMs
      )
    end
  end
end

local out = {}
for i, entry in ipairs(planned) do
  out[i] = {
    allowed = entry.allowed,
    count = entry.count,
    remaining = entry.remaining,
    resetTime = entry.resetTime,
    limit = entry.limit,
  }
end

return cjson.encode({ allowed = not denied, results = out })
`;

export const BAN_STRIKE_LUA = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then
  redis.call("PEXPIRE", KEYS[1], tonumber(ARGV[2]))
end
if count >= tonumber(ARGV[1]) then
  local untilMs = tonumber(ARGV[4]) + tonumber(ARGV[3])
  redis.call("SET", KEYS[2], tostring(untilMs), "PX", tonumber(ARGV[3]))
  redis.call("DEL", KEYS[1])
  return tostring(untilMs)
end
return ""
`;
