// Fictional content for the Meridian Property Group demo workspace. Every
// person, tenant, vendor and address here is invented.

export const DOMAIN = 'meridian.example';
export const SAHIL_EMAIL = 'investhome365@gmail.com';

export type Role = 'admin' | 'manager' | 'employee';

export interface Person {
  key: string;
  name: string;
  /** local part of the @meridian.example address */
  handle: string;
  role: Role;
  title: string;
  managerKey?: string;
  tz?: string;
  joinDay: string;          // YYYY-MM-DD member createdAt
  leftDay?: string;         // deactivated on this day
  invitedByKey?: string;
  authProvider?: 'email' | 'google';
  /** Rough activity level; drives how many tasks/messages they generate. */
  weight: number;
  prefs?: any;
  /** Joined via an Invitation row that still exists (accepted). */
  acceptedInvite?: boolean;
  /** Brand-new: no lists, tasks or chats. */
  isNewHire?: boolean;
}

export const PEOPLE: Person[] = [
  // Admins
  { key: 'dana', name: 'Dana Whitfield', handle: 'dana.whitfield', role: 'admin', title: 'Owner / Principal', joinDay: '2024-04-01', weight: 1.0,
    prefs: { pushEnabled: true, inAppEnabled: true, channels: { chat: true }, quietHours: { enabled: true, startHour: 22, endHour: 7 } } },
  { key: 'elena', name: 'Elena Marsh', handle: 'elena.marsh', role: 'admin', title: 'Operations Director', joinDay: '2024-04-02', invitedByKey: 'dana', weight: 0.9 },
  // Managers
  { key: 'marcus', name: 'Marcus Bell', handle: 'marcus.bell', role: 'manager', title: 'Operations Manager', joinDay: '2024-04-03', invitedByKey: 'dana', weight: 1.2,
    prefs: { pushEnabled: true, inAppEnabled: true, channels: { chat: true, task_status: true } } },
  { key: 'priya', name: 'Priya Natarajan', handle: 'priya.natarajan', role: 'manager', title: 'Accounting Manager', joinDay: '2024-04-08', invitedByKey: 'dana', weight: 0.9,
    prefs: { pushEnabled: false, inAppEnabled: true } },
  // Core team under Marcus
  { key: 'jordan', name: 'Jordan Reyes', handle: 'jordan.reyes', role: 'employee', title: 'Leasing Agent', managerKey: 'marcus', joinDay: '2024-04-15', invitedByKey: 'dana', weight: 1.0 },
  { key: 'luis', name: 'Luis Ortega', handle: 'luis.ortega', role: 'employee', title: 'Maintenance Technician', managerKey: 'marcus', tz: 'America/Chicago', joinDay: '2024-04-15', invitedByKey: 'marcus', weight: 1.1,
    prefs: { pushEnabled: true, inAppEnabled: true, channels: { task_status: false } } },
  { key: 'tasha', name: 'Tasha Williams', handle: 'tasha.williams', role: 'employee', title: 'Maintenance Technician', managerKey: 'marcus', joinDay: '2024-09-09', invitedByKey: 'marcus', weight: 1.0, acceptedInvite: true },
  { key: 'kevin', name: 'Kevin Doyle', handle: 'kevin.doyle', role: 'employee', title: 'Property Coordinator', managerKey: 'marcus', joinDay: '2025-03-10', invitedByKey: 'elena', weight: 1.0, acceptedInvite: true },
  // Under Priya
  { key: 'amara', name: 'Amara Okafor', handle: 'amara.okafor', role: 'employee', title: 'Bookkeeper', managerKey: 'priya', joinDay: '2025-06-02', invitedByKey: 'priya', weight: 0.9, acceptedInvite: true,
    prefs: { pushEnabled: true, inAppEnabled: true, channels: { chat: false } } },
  // Reports to Sahil
  { key: 'nadia', name: 'Nadia Haddad', handle: 'nadia.haddad', role: 'employee', title: 'Portfolio Analyst', managerKey: 'sahil', joinDay: '2025-01-13', invitedByKey: 'dana', weight: 0.7 },
  { key: 'omar', name: 'Omar Siddiqui', handle: 'omar.siddiqui', role: 'employee', title: 'Acquisitions Associate', managerKey: 'sahil', joinDay: '2025-08-18', invitedByKey: 'dana', weight: 0.6 },
  // Google-only account
  { key: 'grace', name: 'Grace Lin', handle: 'grace.lin', role: 'employee', title: 'Leasing Associate', managerKey: 'marcus', joinDay: '2025-10-06', invitedByKey: 'marcus', weight: 0.5, authProvider: 'google' },
  // Junior / light-data staff
  { key: 'diego', name: 'Diego Alvarez', handle: 'diego.alvarez', role: 'employee', title: 'Maintenance Technician', managerKey: 'marcus', joinDay: '2025-04-21', invitedByKey: 'marcus', weight: 0.5 },
  { key: 'hannah', name: 'Hannah Pierce', handle: 'hannah.pierce', role: 'employee', title: 'Leasing Assistant', managerKey: 'marcus', joinDay: '2025-07-07', invitedByKey: 'dana', weight: 0.35 },
  { key: 'samir', name: 'Samir Patel', handle: 'samir.patel', role: 'employee', title: 'Maintenance Technician', managerKey: 'marcus', joinDay: '2025-09-15', invitedByKey: 'marcus', weight: 0.4 },
  { key: 'chloe', name: 'Chloe Nguyen', handle: 'chloe.nguyen', role: 'employee', title: 'Resident Services Coordinator', managerKey: 'marcus', joinDay: '2025-11-03', invitedByKey: 'elena', weight: 0.35 },
  { key: 'victor', name: 'Victor Osei', handle: 'victor.osei', role: 'employee', title: 'Groundskeeper', managerKey: 'marcus', joinDay: '2026-03-02', invitedByKey: 'marcus', weight: 0.25 },
  { key: 'maya', name: 'Maya Thompson', handle: 'maya.thompson', role: 'employee', title: 'Leasing Assistant', managerKey: 'marcus', joinDay: '2026-04-13', invitedByKey: 'dana', weight: 0.3 },
  { key: 'ethan', name: 'Ethan Brooks', handle: 'ethan.brooks', role: 'employee', title: 'Maintenance Helper', managerKey: 'marcus', joinDay: '2026-06-01', invitedByKey: 'marcus', weight: 0.25 },
  { key: 'lucas', name: 'Lucas Moreau', handle: 'lucas.moreau', role: 'employee', title: 'Accounts Payable Clerk', managerKey: 'priya', joinDay: '2025-09-29', invitedByKey: 'priya', weight: 0.35 },
  { key: 'isabel', name: 'Isabel Rocha', handle: 'isabel.rocha', role: 'employee', title: 'Accounts Receivable Specialist', managerKey: 'priya', joinDay: '2026-01-12', invitedByKey: 'priya', weight: 0.35 },
  { key: 'noah', name: 'Noah Fischer', handle: 'noah.fischer', role: 'employee', title: 'Junior Accountant', managerKey: 'priya', joinDay: '2026-05-18', invitedByKey: 'priya', weight: 0.25 },
  { key: 'aisha', name: 'Aisha Rahman', handle: 'aisha.rahman', role: 'employee', title: 'Office Administrator', managerKey: 'elena', joinDay: '2024-10-14', invitedByKey: 'elena', weight: 0.45 },
  { key: 'tyler', name: 'Tyler Grant', handle: 'tyler.grant', role: 'employee', title: 'Compliance Assistant', managerKey: 'elena', joinDay: '2025-12-01', invitedByKey: 'elena', weight: 0.3 },
  { key: 'sofia', name: 'Sofia Bianchi', handle: 'sofia.bianchi', role: 'employee', title: 'Marketing Coordinator', managerKey: 'elena', joinDay: '2026-02-09', invitedByKey: 'elena', weight: 0.3 },
  { key: 'ryan', name: 'Ryan Mitchell', handle: 'ryan.mitchell', role: 'employee', title: 'Executive Assistant', managerKey: 'dana', joinDay: '2025-05-05', invitedByKey: 'dana', weight: 0.35 },
  // Brand-new hire: 6 days ago, nothing attached (filled in at runtime relative to today)
  { key: 'ben', name: 'Ben Kowalski', handle: 'ben.kowalski', role: 'employee', title: 'Maintenance Technician (Trainee)', managerKey: 'marcus', joinDay: 'NEW_HIRE', invitedByKey: 'marcus', weight: 0, acceptedInvite: true, isNewHire: true },
  // Former employee — deactivated 8 months ago (filled in at runtime)
  { key: 'renee', name: 'Renee Caldwell', handle: 'renee.caldwell', role: 'employee', title: 'Leasing Assistant', managerKey: 'marcus', joinDay: '2024-06-03', leftDay: 'LEFT_8_MONTHS_AGO', invitedByKey: 'dana', weight: 0.6 },
];

// ─────────────────────────────────────────────────────────────── properties

export const PROPERTIES = [
  { key: 'oak', name: 'Oakridge Apartments', short: 'Oakridge', units: ['1A', '1B', '1C', '1D', '2A', '2B', '2C', '2D', '3A', '3B', '3C', '3D', '4A', '4B', '4C', '4D'] },
  { key: 'hv', name: 'Harbor View Townhomes', short: 'Harbor View', units: Array.from({ length: 24 }, (_, i) => String(i + 1)) },
  { key: 'cedar', name: 'Cedar Lane Duplexes', short: 'Cedar Lane', units: ['101A', '101B', '103A', '103B', '105A', '105B'] },
  { key: 'sfh', name: 'Single-family homes', short: 'SFH', units: ['1427 Birch St', '88 Linden Ct', '2210 Walnut Ave', '5 Quarry Rd'] },
];

export function unitLabel(p: typeof PROPERTIES[number], u: string): string {
  return p.key === 'sfh' ? u : `${p.short} ${u}`;
}

export const TENANTS = [
  'the Patels', 'Ms. Alvarez', 'Mr. Okonkwo', 'the Nguyen family', 'Ms. Brennan', 'Mr. Kowalczyk', 'the Hendersons', 'Ms. Delgado',
  'Mr. Yamamoto', 'the Osei-Mensahs', 'Ms. Fontaine', 'Mr. Castellano', 'the Abernathys', 'Ms. Iqbal', 'Mr. Lindqvist', 'the Romero twins',
  'Ms. Achebe', 'Mr. Petrov', 'the Walshes', 'Ms. Kaur', 'Mr. Duarte', 'the Mbekis', 'Ms. Sorensen', 'Mr. Haddad',
];

export const VENDORS = [
  'Bayside Plumbing', 'ClearFlow HVAC', 'Keystone Roofing', 'Sparkle Clean Co.', 'Metro Lock & Key', 'GreenEdge Landscaping',
  'Allied Pest Control', 'Brightline Electric', 'TriState Appliance Repair', 'Summit Painting', 'Northgate Flooring', 'Chesapeake Window & Door',
  'Riverbend Carpet Care', 'Harborline Snow & Ice', 'Patriot Fire Protection', 'BlueSky Gutters',
];

export const ISSUES = [
  'leaking kitchen faucet', 'no hot water', 'running toilet', 'clogged bathtub drain', 'garbage disposal jammed', 'HVAC not cooling',
  'furnace short-cycling', 'smoke detector chirping', 'broken window latch', 'front door deadbolt sticking', 'dishwasher not draining',
  'water stain on bedroom ceiling', 'mold spots in bathroom caulk', 'dryer not heating', 'refrigerator too warm', 'garage door opener dead',
  'ants in kitchen', 'loose stair railing', 'exterior light out', 'sump pump alarm', 'low water pressure', 'bathroom exhaust fan rattling',
  'cracked outlet cover in living room', 'ice maker leaking', 'thermostat blank', 'fence panel down after storm',
];

export const AMOUNTS = ['$185', '$240', '$310', '$425', '$560', '$675', '$890', '$1,150', '$1,480', '$2,300', '$3,750', '$6,200'];

// ─────────────────────────────────────────────────────────────── task templates
// Slots: {unit} {tenant} {vendor} {issue} {amount} {month} {prop} {year}

export interface TaskTpl { t: string; d?: string; pri?: 'low' | 'medium' | 'high' | 'urgent'; check?: string[] }

export const TASK_TPL: Record<string, TaskTpl[]> = {
  leasing: [
    { t: 'Lease renewal — {unit} ({tenant})', d: 'Current lease ends {month}. Send renewal offer with the 3% increase per the pricing sheet. Follow up after 7 days if no reply.', check: ['Pull current lease terms', 'Send renewal offer', 'Confirm tenant response', 'Countersign and file'] },
    { t: 'Showing — {unit} with prospect', d: 'Prospect found us on the listing site. Confirm 30 min before; bring the lockbox code and application packet.' },
    { t: 'Screen application — {unit}', d: 'Run credit/background, verify income (3x rent), and call the previous landlord.', check: ['Credit & background', 'Income verification', 'Landlord reference', 'Decision + notify'] },
    { t: 'Post listing for {unit}', d: 'Photos are in the shared drive. Rent per the pricing sheet; mention the new flooring.', pri: 'high' },
    { t: 'Move-in walkthrough — {unit} ({tenant})', d: 'Complete the move-in condition report with photos of every room. Hand over keys, fobs and the welcome packet.', check: ['Condition report', 'Photos uploaded', 'Keys & fobs', 'Welcome packet', 'Utilities transferred'] },
    { t: 'Send notice to vacate acknowledgment — {unit}', d: '{tenant} gave 60-day notice. Confirm move-out date in writing and schedule the pre-move-out inspection.' },
    { t: 'Return security deposit — {unit} ({tenant})', d: 'Itemize deductions within the statutory window. Attach the move-out report.', pri: 'high', check: ['Compare move-in/out reports', 'Itemize deductions', 'Cut check', 'Mail with statement'] },
    { t: 'Update rent comps for {prop}', d: 'Pull 6–8 comps from the usual sites for 1BR/2BR. Note concessions.' },
    { t: 'Follow up with waitlist prospects — {prop}', d: 'Three prospects asked about 2BR availability. Call in order of inquiry date.' },
    { t: 'Renew listing syndication — {prop}', d: 'The syndication expires end of {month}. Refresh photos before renewing.' },
    { t: 'Collect renewed renters insurance — {unit}', d: 'Policy expired. Tenant promised to send the new certificate by Friday.', pri: 'low' },
    { t: 'Prepare lease packet — {unit} ({tenant})', d: 'Lease, lead disclosure, mold addendum, pet addendum if applicable. Send for e-signature.', check: ['Draft lease', 'Add addenda', 'Send for signature', 'File executed copy'] },
    { t: 'Pet screening — {unit}', d: 'Tenant requested approval for a 40 lb dog. Collect vaccination records and the pet deposit.' },
    { t: 'Approve/deny application — {unit}', d: 'Screening came back. Review and send the decision letter today.', pri: 'high' },
    { t: 'Confirm move-out date with {tenant} — {unit}', d: 'Need written confirmation so turnover can be scheduled.' },
  ],
  maint: [
    { t: '{issue} — {unit}', d: 'Tenant ({tenant}) reported: {issue}. Entry OK any weekday 9–4 with 24h notice.', pri: 'high' },
    { t: 'Work order: {issue} — {unit}', d: 'Reported via the resident portal. Assess, fix if parts are on the truck, otherwise quote and schedule.' },
    { t: 'Replace water heater — {unit}', d: '40-gal gas unit is 14 years old and leaking at the base. Get a quote from {vendor}.', pri: 'high', check: ['Quote from vendor', 'Approve PO', 'Schedule install', 'Haul away old unit', 'Photos of install'] },
    { t: 'Annual furnace service — {prop}', d: 'Coordinate with {vendor}. Tenants need 48h notice; batch units by floor.', check: ['Notify tenants', 'Confirm vendor date', 'Walk with tech', 'Collect service report'] },
    { t: 'Repair fence — {unit}', d: 'Two panels down after the storm. Match the existing cedar pickets.' },
    { t: 'Gutter cleaning — {prop}', d: 'Fall cleaning. {vendor} quoted {amount} for the whole property.', pri: 'low' },
    { t: 'Replace smoke/CO detectors — {unit}', d: 'Detectors past 10-year date. Use the sealed-battery combo units from stock.', pri: 'high' },
    { t: 'Dryer vent cleaning — {prop}', d: 'Schedule {vendor}; all units, lint traps too.', pri: 'medium' },
    { t: 'Fix exterior lighting — {prop} parking lot', d: 'Two pole lights out on the east side. Check the photocell first.' },
    { t: 'Patch and paint — {unit} hallway', d: 'Drywall damage from the move-out. Eggshell, match "Agreeable Gray".' },
    { t: 'Snow removal contract check — {prop}', d: 'Confirm {vendor} has the lot map and the trigger depth (2").', pri: 'low' },
    { t: 'Winterize hose bibs — {prop}', d: 'Shut off and drain all exterior spigots before first freeze.', check: ['North side', 'South side', 'Garage bibs'] },
    { t: 'Pressure wash walkways — {prop}', d: 'Spring clean-up. Avoid the new sealant on the front steps.', pri: 'low' },
    { t: 'Appliance swap — {unit} refrigerator', d: 'Compressor is gone. Order the 18 cu ft top-freezer from the usual supplier.' },
    { t: 'Re-key locks — {unit}', d: 'Turnover re-key. {vendor} can do it same day if we call before noon.', pri: 'high' },
    { t: 'Investigate water bill spike — {unit}', d: 'Usage doubled last cycle. Check toilets, irrigation and the main for leaks.', pri: 'medium' },
    { t: 'Caulk tub surround — {unit}', d: 'Mold in the caulk line. Strip, bleach, re-caulk with the mildew-resistant tube.' },
    { t: 'Service garage door — {unit}', d: 'Opener strains; check springs and the sensor alignment.' },
    { t: 'Quarterly pest treatment — {prop}', d: '{vendor} standing appointment. Leave notices on doors 48h ahead.', pri: 'low' },
    { t: 'Replace bathroom exhaust fan — {unit}', d: 'Rattling; bearings shot. 80 CFM quiet model from stock.' },
  ],
  turnover: [
    { t: 'Turnover — {unit}', d: 'Move-out {month}. Target 10-day turn. Paint, clean, re-key, photos, list.', pri: 'high', check: ['Move-out inspection', 'Re-key', 'Paint', 'Deep clean', 'Carpet clean', 'Photos', 'Punch list walk', 'List unit'] },
    { t: 'Move-out inspection — {unit} ({tenant})', d: 'Walk with the tenant if they want to attend. Photos of every room and the appliances.', check: ['Schedule with tenant', 'Walk & photograph', 'Compare to move-in report', 'Draft deduction list'] },
    { t: 'Deep clean — {unit}', d: 'Book {vendor} for the day after the paint is done.' },
    { t: 'Carpet replacement — {unit}', d: 'Bedrooms only; LVP in the living room stays. {vendor} quoted {amount}.' },
    { t: 'Annual unit inspection — {unit}', d: 'Smoke detectors, GFCIs, under-sink leaks, filters, window locks. Note any unauthorized occupants/pets.', check: ['Smoke/CO test', 'GFCI test', 'Under-sink check', 'HVAC filter', 'Window locks', 'Photos'] },
    { t: 'Pre-move-out inspection — {unit}', d: 'Give {tenant} the cleaning checklist so deductions are not a surprise.' },
    { t: 'Punch list walk — {unit}', d: 'Final walk before listing photos. Bring touch-up paint.' },
    { t: 'Listing photos — {unit}', d: 'Morning light is best in the living room. Stage with the usual kit.' },
    { t: 'Order turnover supplies — {prop}', d: 'Blinds (3), smoke detectors (6), GFCI outlets (4), door stops, cabinet pulls.', pri: 'low' },
  ],
  acct: [
    { t: 'Reconcile {month} rent deposits', d: 'Match bank deposits to the rent roll. Flag anything unapplied by the 5th.', check: ['Download bank statement', 'Match to rent roll', 'Post late fees', 'Flag exceptions'] },
    { t: 'Post late fees — {month}', d: 'Grace period ended on the 5th. Post fees and send notices.', pri: 'high' },
    { t: 'Pay {vendor} invoice ({amount})', d: 'Invoice attached. Net 30. Code to repairs & maintenance — {prop}.' },
    { t: 'Owner statement — {month}', d: 'Generate and send the monthly statement with the GL detail.', pri: 'high' },
    { t: 'Security deposit reconciliation — {prop}', d: 'Escrow balance must match the sum of held deposits. Investigate any variance.' },
    { t: 'Prepare 1099s for vendors — {year}', d: 'Pull YTD payments over $600. Confirm W-9s on file.', pri: 'high', check: ['Pull vendor totals', 'Verify W-9s', 'Generate forms', 'File + mail'] },
    { t: 'Chase unpaid rent — {unit} ({tenant})', d: 'Balance outstanding after the 10th. Call first, then send the formal notice.', pri: 'urgent' },
    { t: 'Set up payment plan — {unit} ({tenant})', d: 'Tenant asked for a 3-month plan on the {amount} balance. Draft the agreement for Priya to approve.' },
    { t: 'Quarterly property tax payment — {prop}', d: 'Due end of {month}. Verify the assessed value matches the appeal result.', pri: 'high' },
    { t: 'Renew property insurance — {prop}', d: 'Policy renews {month}. Compare the quote from the broker against last year.', pri: 'medium' },
    { t: 'Utility bill audit — {prop}', d: 'Compare common-area electric against last year by month. Explain any > 15% jump.', pri: 'low' },
    { t: 'Budget draft — {prop} {year}', d: 'Start from this year\'s actuals; assume 4% expense inflation and 3% rent growth.', check: ['Pull actuals', 'Capex list from Marcus', 'Draft', 'Review with Dana'] },
    { t: 'Record CapEx — {prop} ({vendor})', d: 'Capitalize the {amount} job; 15-year life.' },
    { t: 'Bank reconciliation — operating account ({month})', d: 'Standard month-end close.' },
    { t: 'Deposit interest allocation — {month}', d: 'Allocate escrow interest to tenant ledgers per state rules.', pri: 'low' },
  ],
  vendors: [
    { t: 'Renew contract — {vendor}', d: 'Current agreement expires {month}. Ask for the multi-property rate.', check: ['Request renewal terms', 'Compare 2 alternatives', 'Negotiate', 'Sign'] },
    { t: 'Collect COI — {vendor}', d: 'Certificate of insurance expired. No work until the new one is on file.', pri: 'high' },
    { t: 'Get 3 quotes — {prop} parking lot sealcoat', d: 'Include crack filling and re-striping. Target {month}.' },
    { t: 'Vendor onboarding — {vendor}', d: 'W-9, COI, ACH form, and add to the approved list.', check: ['W-9', 'COI', 'ACH form', 'Add to vendor list'] },
    { t: 'Dispute invoice — {vendor} ({amount})', d: 'Charged for two trips; only one visit was logged. Call and get a credit.' },
    { t: 'Review landscaping scope — {prop}', d: 'Mulch twice a year instead of once; drop the fall aeration.' },
    { t: 'Set up annual fire inspection — {prop}', d: '{vendor} for extinguishers and the alarm panel. Need the certificate for the county.', pri: 'high' },
    { t: 'Elevator service agreement — {prop}', d: 'Compare the full-maintenance vs. oil-and-grease plans.' },
  ],
  compliance: [
    { t: 'Renew rental license — {prop}', d: 'County portal. Upload the lead certificate and the inspection report.', pri: 'high', check: ['Gather documents', 'Submit application', 'Pay fee', 'Post certificate on site'] },
    { t: 'Lead paint certificate renewal — {unit}', d: 'Pre-1978 unit. Schedule the certified inspector before the next lease.', pri: 'high' },
    { t: 'Smoke/CO compliance audit — {prop}', d: 'Verify every unit has detectors on each level and outside sleeping areas per code.', check: ['Pull unit list', 'Walk units', 'Replace missing', 'File audit sheet'] },
    { t: 'Fair housing training refresher — leasing team', d: 'Annual requirement. Share the course link and collect certificates.', pri: 'medium' },
    { t: 'Update lease template for {year} law changes', d: 'Late fee cap and the new notice periods. Have counsel review.', pri: 'high' },
    { t: 'File annual LLC report — {prop} entity', d: 'State portal. Confirm the registered agent is current.' },
    { t: 'Backflow preventer test — {prop}', d: 'Water authority deadline end of {month}. {vendor} does the test and files.', pri: 'medium' },
    { t: 'Fire extinguisher tags — {prop}', d: 'Annual tag inspection. Replace any unit with a pressure gauge out of range.' },
    { t: 'Rental registration — {unit}', d: 'New acquisition. Register with the county before listing.', pri: 'high' },
  ],
  office: [
    { t: 'Monthly ops review — {month}', d: 'Agenda: vacancies, open work orders > 14 days, collections, capex pipeline.', check: ['Vacancy report', 'Work order aging', 'Collections', 'Capex'] },
    { t: 'Renew office internet contract', d: 'Current promo ends {month}. Check the business fiber offer.' },
    { t: 'Order business cards for new hires', d: 'Same template; confirm titles with Elena.', pri: 'low' },
    { t: 'Team lunch — {month}', d: 'Pick a date that works for the techs (not a Monday).', pri: 'low' },
    { t: 'Update emergency contact list', d: 'New vendors and the after-hours line. Post in the shop and the office.' },
    { t: 'Quarterly KPI deck — {month}', d: 'Occupancy, NOI vs budget, turn time, work-order SLA.', pri: 'high' },
    { t: 'Review software subscriptions', d: 'Cancel the two tools nobody opened since {month}.', pri: 'low' },
    { t: 'Plan {year} capital projects', d: 'Roofs, parking lots, water heaters by age. Rank by risk.' },
    { t: 'Schedule 1:1s for {month}', d: 'Rotate the time slots so the techs are not always at 7am.' },
    { t: 'Archive {year} paper files', d: 'Scan the leases, shred per the retention policy.', pri: 'low' },
  ],
  personal: [
    { t: 'Call {tenant} back about {unit}', d: 'They left a voicemail about the {issue}.' },
    { t: 'Pick up parts for {unit}', d: 'Supply house closes at 5.' },
    { t: 'Send {tenant} the renewal reminder', d: '' },
    { t: 'Finish notes from {prop} walk', d: 'Photos are on my phone — upload them to the task.' },
    { t: 'Follow up: {vendor} quote', d: 'Promised the quote by Wednesday.' },
    { t: 'Return the lockbox from {unit}', d: '' },
    { t: 'Draft email to {prop} residents re: {issue}', d: 'Keep it short; include the timeline.' },
    { t: 'Check {unit} after the rain', d: 'Previous leak location in the bedroom closet.' },
    { t: 'Expense report — {month}', d: 'Mileage + the receipts in the glovebox.', pri: 'low' },
    { t: 'Read up on the new {year} notice rules', d: '' },
    { t: 'Confirm {vendor} arrival window', d: '' },
    { t: 'Log {unit} inspection photos', d: '' },
    { t: 'Prep for Monday walkthrough — {prop}', d: 'Print the unit list, charge the flashlight.' },
    { t: 'Reply to {tenant} about parking spot', d: '' },
    { t: 'Order replacement fobs — {prop}', d: '10 fobs, program to the gate controller.', pri: 'low' },
    { t: 'Reconcile my petty cash', d: '', pri: 'low' },
    { t: 'Update the {prop} unit spreadsheet', d: 'Move-in/out dates for {month}.' },
    { t: 'Schedule {vendor} for {unit}', d: '{issue}' },
    { t: 'Write up {unit} ({tenant}) incident', d: 'Just the facts, with timestamps.' },
    { t: 'Clean out the truck', d: '', pri: 'low' },
  ],
};

export const SUBTASK_TPL = [
  'Order parts', 'Notify tenant of entry', 'Take before photos', 'Take after photos', 'Get vendor quote', 'Approve quote with Marcus',
  'Schedule the vendor', 'Confirm access', 'Update the unit file', 'Close out in the portal', 'Collect signatures', 'Send confirmation email',
  'Check parts inventory', 'Verify warranty', 'File receipt with accounting',
];

export const DESCRIPTION_EXTRAS = [
  '\n\nNotes from the phone call: tenant is home mornings only.',
  '\n\nAccess: lockbox on the gas meter, code in the unit file.',
  '\n\nBudget: under $500 no approval needed; above that ask Marcus.',
  '\n\n⚠️ Dog on premises — call ahead.',
  '\n\nTenant speaks Spanish; Luis to call.',
  '',
  '',
  '',
];

// ─────────────────────────────────────────────────────────────── edge cases

export const LONG_TITLE_255 =
  'Coordinate full HVAC condenser replacement for Oakridge Apartments building 3 including crane rental, roof access permit, tenant notifications for units 3A through 3D, electrical disconnect by Brightline Electric, and final inspection sign-off by the county'.slice(0, 255).padEnd(255, '.');

export const EMOJI_TITLES = [
  '🚨 Burst pipe — Harbor View 7 (water shut off)',
  '🔑 Re-key after move-out — Oakridge 2C',
  '🧹 Deep clean before showing — Cedar Lane 103B',
  'Reparar calentador de agua — Oakridge 1D (inquilino sin agua caliente) 🔥',
  'Cambio de cerradura — Harbor View 15 ✅',
  'Revisar fuga en el techo — 1427 Birch St ☔',
  'ओकरिज 4B — किचन सिंक लीक की मरम्मत 🔧',
  'हार्बर व्यू 9 — धुआँ डिटेक्टर बैटरी बदलें',
  'महीने की किराया रिपोर्ट तैयार करें 📊',
];

export const SPANISH_DESC = 'El inquilino reporta que no hay agua caliente desde el martes. Ya revisó el piloto. Necesita visita esta semana — está disponible por la mañana. 🙏';
export const HINDI_DESC = 'किरायेदार ने बताया कि सिंक के नीचे पानी रिस रहा है। कृपया इस हफ़्ते जाँच करें और फ़ोटो अपलोड करें। धन्यवाद! 🙏';

export const LONG_DESCRIPTION_2000 = [
  '## Scope of work — Harbor View roof section C',
  '',
  'This is the follow-up to the 2025 roof replacement. Section C (units 13–18) was **not** included in the original contract because the decking under the north valley needed a structural review first. That review is done and the engineer\'s letter is attached to the parent task.',
  '',
  '### What needs to happen',
  '1. Tear-off of the existing 3-tab shingles and the two layers of felt underneath.',
  '2. Replace any decking that fails the walk test (budget 6 sheets, likely 2–3).',
  '3. Ice-and-water shield on the full valley plus 3 ft up from the eaves.',
  '4. Architectural shingles to match sections A/B — *Weathered Wood*, 30-year.',
  '5. New ridge vent, new pipe boots, re-flash the two chimneys.',
  '6. Gutters stay; protect them during tear-off.',
  '',
  '### Tenant impact',
  '- Noise 7:30am–5pm for ~4 working days. Give everyone in 13–18 **72 hours** notice.',
  '- Parking: the dumpster takes spots 31–33. Tape them off the night before.',
  '- Ms. Fontaine (unit 15) works nights — call her personally so she can plan.',
  '',
  '### References',
  '- Manufacturer install guide: https://docs.example-roofing.com/products/architectural-shingles/weathered-wood/installation-guide-2026-edition?section=valleys&detail=closed-cut&utm_source=taskforge-demo',
  '- County permit portal (use the Meridian login in the vault): https://permits.example-county.gov/portal/applications/new?type=residential-reroof&parcel=HV-00213-0C&applicant=meridian-property-group&return=/dashboard',
  '- Last year\'s photos and the engineer\'s letter: https://files.example-storage.net/meridian/harbor-view/roof/2025/section-c/structural-review/final-letter-and-photos.zip?expires=2027-01-01&sig=demo',
  '',
  '> Keystone quoted $38,400 all-in; Summit was $41,100 but includes the gutter guards. Decision pending Dana — see the comments.',
  '',
  'Checklist is on the task. Close this only when the county inspection is **passed** and the certificate is uploaded.',
].join('\n').slice(0, 2000).padEnd(2000, ' ');

export const BIG_CHECKLIST_12 = [
  'Confirm engineer letter is on file', 'Pull county permit', 'Order shingles & underlayment', 'Reserve dumpster', 'Tape off parking spots 31–33',
  '72-hour notices to units 13–18', 'Call Ms. Fontaine (unit 15)', 'Tear-off day 1', 'Decking replacement', 'Shingles & ridge vent',
  'Final walk with Keystone foreman', 'County inspection passed + certificate uploaded',
];

// ─────────────────────────────────────────────────────────────── comments
// {m:KEY} is replaced with the @email mention of a participant role.

export const COMMENT_TPL = {
  opener: [
    'Picked this up. Will swing by {unit} tomorrow morning.',
    'Called {tenant} — they are home after 1pm most days.',
    'Added photos from today. The {issue} is worse than described.',
    'Scheduled {vendor} for Thursday between 8 and 12.',
    'Parts are on back-order until next week. Leaving a note for the tenant.',
    'Quick update: this is done except for the final photos.',
    'Heads up — tenant has a dog, call before you go in.',
    'Quote came in at {amount}. Attaching it.',
    'Ya hablé con el inquilino, dice que puede estar en casa el jueves por la tarde. 👍',
    'मैंने वेंडर को कॉल कर दिया है, वे शुक्रवार को आएँगे।',
    'Lockbox code changed — check the unit file.',
    'This is blocked on the COI from {vendor}.',
    'Moving this to waiting — tenant is traveling until the 20th.',
  ],
  mention: [
    '{m:0} can you approve the {amount} quote? Need to confirm with {vendor} by noon.',
    '{m:0} FYI the tenant asked for a copy of the inspection report.',
    '{m:0} do you have the key to the mechanical room? Mine does not work.',
    '{m:0} please take this one — I am at {prop} all day.',
    '{m:0} the {issue} at {unit} is likely a warranty item, can you check the paperwork?',
    '{m:0} ready for your review.',
    '{m:0} ¿puedes pasar por {unit} mañana? El inquilino solo está por la mañana.',
    '{m:0} can you post this to the ledger once the check clears?',
    '{m:0} anything else needed before I close this out?',
  ],
  reply: [
    'Approved — go ahead.',
    'Yes, I will handle it this afternoon.',
    'Thanks! Closing it out.',
    'Got it, on my way.',
    'Let me check and get back to you by EOD.',
    'Hold off until I confirm with the owner.',
    '👍',
    'Done ✅',
    'Perfect, gracias.',
    'ठीक है, कर देता हूँ।',
    'Can we push this to next week? Two emergencies today.',
    'Photos look good. Approve for payment.',
  ],
  sahil: [
    '{m:0} can you review this before the owner call on Friday?',
    '{m:0} flagging for you — this one is over the approval threshold.',
    '{m:0} do you want the KPI numbers by property or by entity?',
    '{m:0} the county asked for the LLC docs — do you have the latest operating agreement?',
    '{m:0} need your sign-off on the {amount} capex before Priya posts it.',
    '{m:0} ready for review — tested on the TEST workspace first 😄',
    '{m:0} ¿te parece bien el presupuesto para {prop}?',
    '{m:0} FYI this vendor asked for net-15 instead of net-30.',
  ],
};

// ─────────────────────────────────────────────────────────────── chat scenes
// `roles` is the number of distinct speakers the scene needs. Lines are
// [roleIndex, text]. Slots as above.

export interface Scene { roles: number; theme: 'maint' | 'leasing' | 'acct' | 'lead' | 'general' | 'turnover'; lines: [number, string][] }

export const SCENES: Scene[] = [
  { roles: 2, theme: 'maint', lines: [[0, 'Hey, {tenant} at {unit} called again about the {issue}. Can you get there today?'], [1, 'On it. Finishing up at {prop} first, should be there by 2.'], [0, 'Perfect. They said use the side door, front buzzer is broken too 🙄'], [1, 'Of course it is. Adding that to the list.'], [1, 'Done. Needed a new cartridge. Also fixed the buzzer, it was just the button.'], [0, 'Legend. Close the ticket when you can.']] },
  { roles: 2, theme: 'maint', lines: [[0, 'Quote from {vendor} for {unit}: {amount}. Seems high?'], [1, 'That includes haul-away and the permit. Still, ask them to sharpen it by 10%.'], [0, 'Will do.'], [0, 'They came back at a bit less. Approve?'], [1, 'Approved. Get it on the calendar before the cold snap.']] },
  { roles: 2, theme: 'maint', lines: [[0, 'Water heater at {unit} is leaking from the bottom. Shut the supply and gas.'], [1, 'Good call. How old is it?'], [0, 'Label says 2011.'], [1, 'Replace, not repair. Order the 40-gal from the supply house, I will open a task.'], [0, '👍 Tenant is fine with no hot water tonight, I told them tomorrow by noon.']] },
  { roles: 2, theme: 'maint', lines: [[0, 'Ya llegué a {unit}, el inquilino no está 🙃'], [1, 'Call them, they said they would be home.'], [0, 'No contesta. Espero 10 minutos más.'], [0, 'Ok llegó. Era el disposal, ya quedó.'], [1, 'Gracias Luis 🙏']] },
  { roles: 3, theme: 'maint', lines: [[0, 'Storm tonight — who can be on call?'], [1, 'I can take it.'], [2, 'I am 30 min out but can back you up.'], [0, 'Thanks both. Sump pumps at Cedar Lane are the usual suspects.'], [1, 'Already checked the floats this afternoon 👌']] },
  { roles: 3, theme: 'maint', lines: [[0, 'Filter day at {prop} tomorrow. {unit} and the two above need 20x25.'], [1, 'We only have 16x25 in the shop.'], [2, 'I can grab a case on the way in.'], [0, 'Do that. Save the receipt for Amara.']] },
  { roles: 2, theme: 'maint', lines: [[0, 'Missed call — tried you about the Harbor View leak'], [1, 'Sorry, was under a sink. What happened?'], [0, 'Ceiling stain in {unit}, right under the upstairs bathroom.'], [1, 'Probably the tub drain gasket again. I will cut an access panel tomorrow.']] },
  { roles: 2, theme: 'maint', lines: [[0, 'Photo of the panel at {unit} — see the scorched breaker?'], [1, 'Yeah, that is a Brightline job, not us. Tag it out and open a task.'], [0, 'Tagged. Tenant is on the other breaker for the fridge for now.']] },
  { roles: 2, theme: 'leasing', lines: [[0, 'Showing at {unit} at 4 — can you make sure the lockbox has the right key?'], [1, 'Just checked, you are good. Lights are on a timer too.'], [0, 'Thanks! Prospect sounds strong, two incomes.'], [0, 'They applied on the spot 🎉'], [1, 'Nice work. Run screening tonight?'], [0, 'Already running.']] },
  { roles: 2, theme: 'leasing', lines: [[0, '{tenant} at {unit} want to renew but asked for no increase.'], [1, 'Offer 2% instead of 3 and a 14-month term. They have been great tenants.'], [0, 'Sending the revised offer now.'], [0, 'Signed! 14 months.'], [1, '🙌']] },
  { roles: 2, theme: 'leasing', lines: [[0, 'Notice to vacate from {unit}, end of {month}.'], [1, 'Ok — start the turnover task and get the pre-move-out scheduled.'], [0, 'Done. Also posting the listing 30 days out as usual?'], [1, 'Yes, photos from last turnover are fine if nothing changed.']] },
  { roles: 2, theme: 'leasing', lines: [[0, 'Application for {unit} came back with a collections account.'], [1, 'How old and how much?'], [0, '2022, medical, {amount}.'], [1, 'Medical we can overlook per our policy. Income check out?'], [0, '3.4x rent.'], [1, 'Approve.']] },
  { roles: 2, theme: 'acct', lines: [[0, 'Deposits are in. Two unmatched — {unit} and {unit2}.'], [1, '{unit} paid by money order last month, check the lockbox scan.'], [0, 'Found it. {unit2} is short by {amount}.'], [1, 'Send the balance notice today, late fee posts on the 6th.'], [0, 'Sent 📨']] },
  { roles: 2, theme: 'acct', lines: [[0, '{vendor} invoice for {amount} has no PO number.'], [1, 'Ask Marcus which task it belongs to before paying.'], [0, 'He says it is the {unit} water heater.'], [1, 'Code it to R&M for {prop} and pay net-30.']] },
  { roles: 2, theme: 'acct', lines: [[0, 'Owner statements for {month} are ready for review.'], [1, 'Looking now.'], [1, 'Looks good except the insurance line on {prop} — that should be prepaid, not expense.'], [0, 'Fixed and re-exported.'], [1, 'Send them.']] },
  { roles: 2, theme: 'acct', lines: [[0, 'आज शाम तक रिपोर्ट भेज दूँगी 🙏'], [1, 'Great, thanks. No rush before tomorrow morning.']] },
  { roles: 2, theme: 'lead', lines: [[0, 'Occupancy is at 96%. Two vacancies, both already have applications.'], [1, 'Good. What is the work-order backlog looking like?'], [0, '11 open over 14 days, mostly waiting on {vendor}.'], [1, 'Let us talk about a second HVAC vendor at the ops review.']] },
  { roles: 2, theme: 'lead', lines: [[0, 'Roof quotes for Harbor View section C: Keystone {amount}, Summit a bit more but with gutter guards.'], [1, 'Keystone did sections A/B and the warranty is one vendor then. Go with Keystone.'], [0, 'Agreed. I will approve the task.']] },
  { roles: 3, theme: 'lead', lines: [[0, 'Budget drafts for {year} are in the Accounting list.'], [1, 'I will review the capex lines this week.'], [2, 'Can we add the parking lot sealcoat for {prop}? It has slipped two years in a row.'], [0, 'Added. {amount} placeholder until the quotes come in.']] },
  { roles: 2, theme: 'lead', lines: [[0, 'Can you send me the KPI deck before the owner call?'], [1, 'Sending now. Occupancy, NOI vs budget, turn time, SLA.'], [0, 'Perfect, thanks.']] },
  { roles: 2, theme: 'general', lines: [[0, 'Running 15 late, traffic on the beltway.'], [1, 'No problem, coffee is on.']] },
  { roles: 2, theme: 'general', lines: [[0, 'Did anyone take the ladder from the {prop} shop?'], [1, 'It is in my truck, sorry! Bringing it back at lunch.']] },
  { roles: 2, theme: 'general', lines: [[0, 'Out tomorrow — dentist. Luis has my units.'], [1, 'Noted, feel better.']] },
  { roles: 2, theme: 'general', lines: [[0, 'Who has the gate remote for Cedar Lane?'], [1, 'Kevin had it last.'], [0, 'Thanks']] },
  { roles: 3, theme: 'general', lines: [[0, 'Team lunch Thursday — tacos or pizza?'], [1, 'Tacos 🌮'], [2, 'Tacos'], [0, 'Tacos it is.']] },
  { roles: 2, theme: 'general', lines: [[0, 'Reminder: county inspector at {prop} 9am Friday. Common areas need to be spotless.'], [1, 'Sparkle Clean is booked for Thursday afternoon.']] },
  { roles: 3, theme: 'turnover', lines: [[0, 'Turnover at {unit}: move-out inspection done, deductions look like {amount}.'], [1, 'Paint crew can start Monday.'], [2, 'Re-key Tuesday after paint, then I shoot photos Wednesday.'], [0, 'Listing goes live Thursday then. Nice.']] },
  { roles: 3, theme: 'turnover', lines: [[0, 'Carpet in {unit} bedrooms is shot. Replace or clean?'], [1, 'Replace — it is 9 years old.'], [2, '{vendor} can do it Friday for {amount}.'], [1, 'Book it.']] },
  { roles: 2, theme: 'turnover', lines: [[0, 'Punch list for {unit}: two outlet covers, touch-up in the hall, blind in bedroom 2.'], [1, 'All done except the blind, picking one up now.'], [0, '🙏']] },
  { roles: 2, theme: 'general', lines: [[0, 'New resident portal article is live: https://help.example-portal.com/articles/how-to-submit-a-maintenance-request'], [1, 'Nice, sharing it in the welcome packet.']] },
];

export const FILLERS = ['👍', 'Thanks!', 'On it.', 'Sounds good.', 'Will do.', 'Perfect.', 'ok', 'Got it 👌', 'Gracias!', 'See you there.', 'Noted.', '🙏'];

export const REACTIONS = ['👍', '🙏', '😂', '✅', '❤️', '🔥', '👀', '🎉'];

export const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (iPad; CPU OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
];

export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export const INVOICE_TXT = (vendor: string, amount: string, prop: string) => [
  `${vendor}`,
  'INVOICE',
  '',
  `Bill to: Meridian Property Group — ${prop}`,
  `Amount due: ${amount}`,
  'Terms: Net 30',
  '',
  'Thank you for your business. (Demo data — not a real invoice.)',
].join('\n');
