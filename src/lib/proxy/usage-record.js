// The RESP usage channel also carries capability/control notifications on
// subscribe and reconnect. Zero tokens alone do not identify a control frame:
// real failed, canceled and even successful requests can have zero usage.
function isControlNotification(record) {
  return record !== null && typeof record === "object" &&
    Object.hasOwn(record, "support_refresh");
}

function isUsageRecord(record) {
  return record !== null && typeof record === "object" &&
    !Array.isArray(record) && !isControlNotification(record);
}

module.exports = { isControlNotification, isUsageRecord };
