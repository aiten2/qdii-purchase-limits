const DEFAULT_SCHEDULE = [
  { name: "盘前", time: "09:10" },
  { name: "盘中", time: "14:30" },
  { name: "盘后", time: "20:30" }
];

function zonedParts(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone || "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    minutes: Number(values.hour) * 60 + Number(values.minute)
  };
}

function slotKey(date, time) {
  return `${date}@${time}`;
}

function findDueSlot(now, schedule, completedSlots, timezone) {
  const local = zonedParts(now, timezone);
  const completed = new Set(completedSlots || []);
  const latestDue = (schedule || DEFAULT_SCHEDULE)
    .map((slot) => {
      const [hour, minute] = slot.time.split(":").map(Number);
      return Object.assign({}, slot, { minutes: hour * 60 + minute, key: slotKey(local.date, slot.time), date: local.date });
    })
    .filter((slot) => slot.minutes <= local.minutes)
    .sort((left, right) => right.minutes - left.minutes)[0] || null;
  if (!latestDue || completed.has(latestDue.key)) return null;
  return latestDue;
}

module.exports = { DEFAULT_SCHEDULE, findDueSlot, slotKey, zonedParts };
