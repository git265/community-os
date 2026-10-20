// Cultural events of 2025 and 2026 from the committee's spreadsheets (budget = the estimate made in advance, actual = what was spent).
// Where a sheet total and the summary disagreed, the event sheet's own total was used (see README "Round 26").
// Events dated after today carry only their estimate; the 2026 summary repeated last year's expense for several of them, so those were NOT taken as actuals.
const E = (id, name, series, type, size, date, budget, actual, extra = {}) => ({
  id, name, series, type, size, startDate: date, endDate: date, venue: '', status: 'Completed', visibility: 'Internal', programmeStatus: 'Draft', fund: 'Cultural',
  budget: budget ?? 0, ...(actual != null ? { historicalActual: actual } : {}), description: '', ...extra,
});

export const CULTURAL_HISTORY = [
  // ---------------------------------------------------------------- 2025
  E('ch25-1', 'Bhogi & Sankranthi 2025', 'Bhogi & Sankranthi', 'Festival', 'Medium', '2025-01-14', 35000, 29904),
  E('ch25-2', 'Holi 2025', 'Holi', 'Festival', 'Medium', '2025-03-14', 35000, 27568),
  E('ch25-3', 'Ugadi 2025', 'Ugadi', 'Festival', 'Small', '2025-03-30', 25000, 16420),
  E('ch25-4', 'Sri Rama Navami 2025', 'Sri Rama Navami', 'Festival', 'Large', '2025-04-06', 200000, 95758),
  E('ch25-5', 'Kids Carnival 2025', 'Kids Carnival', 'Celebration', 'Small', '2025-06-09', 15000, 11457),
  E('ch25-6', 'Independence Day 2025', 'Independence Day', 'Celebration', 'Small', '2025-08-15', 0, 50555, { fund: '', description: '<p>Community-fund event. The 2025 sheet has no budget line.</p>' }),
  E('ch25-7', 'Vinayaka Chavithi 2025', 'Vinayaka Chavithi', 'Festival', 'Large', '2025-08-27', 165000, 370000, { fund: 'Ganesh' }),
  E('ch25-8', 'Bathukamma 2025', 'Bathukamma', 'Festival', 'Medium', '2025-09-23', 35000, 26123),
  E('ch25-9', 'Dussara - Dandiya - Navaratri 2025', 'Dussara - Dandiya - Navaratri', 'Festival', 'Medium', '2025-09-27', 35000, 37408),
  E('ch25-10', 'Diwali 2025', 'Diwali', 'Festival', 'Medium', '2025-10-20', 35000, 1920),
  E('ch25-11', 'Children’s Day 2025', 'Children’s Day', 'Celebration', 'Small', '2025-11-14', 20000, 15245),
  E('ch25-12', 'Christmas 2025', 'Christmas', 'Celebration', 'Small', '2025-12-25', 20000, 13313),
  // ---------------------------------------------------------------- 2026
  E('ch26-1', 'Sports Day 2026', 'Sports Day', 'Sports / games', 'Large', '2026-01-26', 100000, null, { fund: '', description: '<p>Separate fund. No actual in the sheet yet.</p>' }),
  E('ch26-2', 'Republic Day 2026', 'Republic Day', 'Celebration', 'Small', '2026-01-26', 20000, null, { fund: '', description: '<p>From the community fund. No actual in the sheet yet.</p>' }),
  E('ch26-3', 'Bhogi & Sankranthi 2026', 'Bhogi & Sankranthi', 'Festival', 'Medium', '2026-01-14', 35000, 34959),
  E('ch26-4', 'Holi 2026', 'Holi', 'Festival', 'Medium', '2026-03-04', 35000, 25810),
  E('ch26-5', 'Ugadi 2026', 'Ugadi', 'Festival', 'Small', '2026-03-19', 25000, 23962),
  E('ch26-6', 'Sri Rama Navami 2026', 'Sri Rama Navami', 'Festival', 'Large', '2026-03-26', 200000, 157199),
  E('ch26-7', 'Kids Carnival 2026', 'Kids Carnival', 'Celebration', 'Small', '2026-07-06', 15000, 8350),
  E('ch26-8', 'Independence Day 2026', 'Independence Day', 'Celebration', 'Small', '2026-08-15', 20000, 29582, { fund: '', description: '<p>From the community fund.</p>' }),
  E('ch26-9', 'Bathukamma 2026', 'Bathukamma', 'Festival', 'Medium', '2026-10-12', 35000, null, { description: '<p>Actual not entered yet.</p>' }),
  E('ch26-10', 'Dussara - Dandiya - Navaratri 2026', 'Dussara - Dandiya - Navaratri', 'Festival', 'Medium', '2026-10-20', 35000, null, { status: 'Planning' }),
  E('ch26-11', 'Children’s Day 2026', 'Children’s Day', 'Celebration', 'Small', '2026-11-14', 20000, null, { status: 'Planning' }),
  E('ch26-12', 'Christmas 2026', 'Christmas', 'Celebration', 'Small', '2026-12-25', 20000, null, { status: 'Planning' }),
];
