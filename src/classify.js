// Turns raw job titles and company names into things we can group and filter on.

export function normCompany(name = '') {
  return name
    .toLowerCase()
    .replace(/\b(labs?|inc\.?|ltd\.?|limited|llc|foundation|protocol|network|technologies|corp\.?)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function normTitle(title = '') {
  return title
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')                 // drop "(Remote)", "(EU)" etc.
    .replace(/\b(remote|hybrid|onsite|on-site|emea|apac|americas|us|eu|uk)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const SENIOR_RE = /\b(senior|sr\.?|staff|principal|lead|head|director|vp|vice president|chief|cto|ceo|coo|cfo|founding|engineering manager)\b/i;

export function isSenior(title = '') {
  return SENIOR_RE.test(title);
}

// Order matters: the first category that matches wins.
const CATEGORIES = [
  ['security', /\b(security|auditor|audit|appsec|red team|offensive|threat|incident response)\b/i],
  ['engineering', /\b(engineer|engineering|developer|dev|solidity|rust|golang|go developer|smart contract|protocol|blockchain|backend|back-end|frontend|front-end|full[- ]?stack|devops|sre|infrastructure|data scientist|researcher|cryptographer|zk|architect|ml|machine learning|qa|tester)\b/i],
  ['bd', /\b(business development|bd|partnerships?|sales|account (executive|manager)|ecosystem|institutional|growth lead|commercial)\b/i],
  ['marketing', /\b(marketing|community|content|social|brand|communications|comms|devrel|developer relations|pr|growth)\b/i],
  ['ops', /\b(operations|ops|finance|legal|compliance|counsel|hr|people|talent|recruit|accountant|controller|product manager|product owner|designer|design)\b/i],
];

// The title decides first; the department is only a fallback (a "Community Manager"
// listed under an Engineering department is still a marketing hire).
export function categorize(title = '', department = '') {
  for (const text of [title, department]) {
    for (const [cat, re] of CATEGORIES) if (re.test(text)) return cat;
  }
  return 'other';
}

const TECH_WORDS = ['solidity', 'rust', 'go', 'golang', 'typescript', 'zk', 'evm', 'move', 'cairo', 'smart contract', 'protocol', 'defi'];

export function techTags(title = '') {
  const t = ` ${title.toLowerCase()} `;
  return TECH_WORDS.filter((w) => t.includes(` ${w} `) || t.includes(` ${w},`) || t.includes(`/${w}`));
}
