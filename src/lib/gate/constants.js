// GateGuard constants shared by the schemas, the rules engine and the screens (pure data, no imports).
export const PERSON_CLASSES = ['Maid / cook', 'Nanny / caretaker', 'Driver', 'Delivery rider', 'Daily worker', 'Landscaper', 'Vendor staff', 'Contractor', 'Other'];
/** Classes that work for a villa (linked to villas, days and hours) vs. classes that work for the community (rostered on a work order). */
export const VILLA_CLASSES = ['Maid / cook', 'Nanny / caretaker', 'Driver'];
export const CREW_CLASSES = ['Daily worker', 'Landscaper', 'Vendor staff', 'Contractor'];
export const PERSON_STATUS = ['Invited', 'Documents pending', 'Under review', 'Active', 'Suspended', 'Blocked'];
export const VISIT_KINDS = ['Guest', 'Delivery', 'Cab', 'Maid / cook', 'Driver', 'Crew', 'Staff', 'Resident vehicle', 'Goods vehicle', 'Emergency', 'Other'];
export const GOODS_KINDS = ['Move in', 'Move out', 'Goods delivery', 'Contractor / materials', 'Waste / tanker', 'Other'];
export const MANUAL_REASONS = ['Face did not match', 'Kiosk offline', 'Poor light or camera', 'Visitor cannot use the kiosk', 'Other'];
export const VISIT_STATES = ['Awaiting approval', 'Approved', 'Denied', 'No answer', 'Inside', 'Exited', 'Auto-closed', 'Left at gate', 'Refused'];
export const APPROVAL_STATES = ['Pending', 'Approved', 'Denied', 'No answer'];
export const FLAG_TYPES = ['Unrecorded entry', 'Tailgate', 'Override entry', 'Identity mismatch', 'Wrong destination', 'Overstay', 'Blocked person attempt', 'Guard silence', 'Headcount mismatch', 'Manual open', 'Missed patrol', 'Reported person', 'Patrol location'];
/** Where a patrol scan was taken, from the phone's GPS (the same words as the server's). */
export const SCAN_PLACES = ['At the post', 'Away from the post', 'Weak signal', 'No location', 'Location off', 'Post not mapped'];
export const PATROL_GPS = { weakM: 100, sameSpotM: 10, radiusM: 40 };
/** Why a villa reports someone who works for it to security. */
export const REPORT_REASONS = ['No longer works for us', 'Suspected theft', 'Misbehaviour', 'Other'];
export const FLAG_STATES = ['Watching', 'Open', 'Closed'];
export const FLAG_RESOLUTIONS = ['Registered late', 'False alarm', 'Escorted out', 'Escalated to manager'];
export const PASS_TYPES = ['One-time', 'Recurring', 'Event', 'Goods'];
export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const DELIVERY_MODES = ['Allow listed', 'Allow all', 'Ask me each time', 'Leave at gate'];
export const DELIVERY_COMPANIES = ['Amazon', 'Flipkart', 'Blinkit', 'Zepto', 'Swiggy', 'Zomato', 'BigBasket', 'Courier / post', 'Other'];
export const VEHICLE_CLASSES = ['Resident', 'Tenant', 'Staff', 'Vendor', 'Driver'];
export const GATE_NAMES = ['Main gate', 'Service gate', 'Gate 3'];
export const FALLBACKS = ['Hold at gate', 'Deny'];
/** Minutes a visit may last before it is an overstay, by kind (settings can change them). */
export const DEFAULT_DURATIONS = { Guest: 240, Delivery: 20, Cab: 15, 'Maid / cook': 480, Driver: 600, Crew: 480, 'Goods vehicle': 240, 'Resident vehicle': 0, Emergency: 120, Other: 120 };
/** Notification events: who is told by default, and whether the photo is attached. `villa` = the host villa, `security` = guard supervisor + security roles, `manager` = security manager + EC, `fm` = facility manager. */
export const GATE_EVENTS = [
  { id: 'approval', label: 'Approval needed', to: 'villa', photo: true, locked: true },
  { id: 'guest_arrived', label: 'Guest or pass holder arrived', to: 'villa', photo: true },
  { id: 'guest_exit', label: 'Guest exited', to: 'villa', photo: false },
  { id: 'delivery', label: 'Delivery arrived or left at gate', to: 'villa', photo: true },
  { id: 'staff_inout', label: 'Maid, cook or driver in or out', to: 'villa', photo: true },
  { id: 'crew_inout', label: 'Crew member in or out', to: 'fm', photo: false },
  { id: 'overstay', label: 'Overstay or no exit', to: 'villa+security', photo: true, locked: true },
  { id: 'ghost', label: 'Ghost entry flag', to: 'security+manager', photo: true, locked: true },
  { id: 'override', label: 'Guard override', to: 'manager', photo: true, locked: true },
  { id: 'blocked', label: 'Blocked person attempt', to: 'manager', photo: true, locked: true },
  { id: 'vetting', label: 'Vetting expiring or rejected', to: 'manager', photo: false },
];
export const DEFAULT_SETTINGS = {
  id: 'default',
  passMessage: 'Hi {guest}, {host} ({unit}) has made you a pass for {community}.\nCode: {pin}\nValid: {date}{time}\n{vehicle}Show the QR or tell the guard the code at the gate.',
  kioskOn: false, goodsExtraPeople: 'Block until the guard confirms', patrolMinSeconds: 20,
  waitSeconds: 60, fallback: 'Hold at gate', graceSeconds: 30, overstayGraceMinutes: 10, guardSilenceMinutes: 45, autoCloseHours: 2,
  quietFrom: '22:00', quietTo: '06:00', quietFallback: 'Hold at gate', photoRetentionDays: 90,
  durations: DEFAULT_DURATIONS,
  approvedCompanies: ['Amazon', 'Flipkart', 'Blinkit', 'Zepto', 'Swiggy', 'Zomato', 'BigBasket', 'Courier / post'],
  events: Object.fromEntries(GATE_EVENTS.map((e) => [e.id, { on: true, photo: e.photo }])),
};
