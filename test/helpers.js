// A fake "internet" for tests: maps URLs to canned responses shaped like the real APIs.
export function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [pattern, handler] of routes) {
      if (String(url).includes(pattern)) {
        const out = typeof handler === 'function' ? handler(String(url), init) : handler;
        if (out instanceof Error) throw out;
        const status = out?.__status || 200;
        return {
          ok: status < 400, status,
          json: async () => out,
          text: async () => JSON.stringify(out),
        };
      }
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => 'not found' };
  };
  fn.calls = calls;
  return fn;
}

// Greenhouse: { jobs: [...] } with the keys seen in a live Coinbase response.
export const greenhouse = (company, jobs) => ({
  jobs: jobs.map(([id, title, loc, published]) => ({
    absolute_url: `https://boards.greenhouse.io/${company}/jobs/${id}`, data_compliance: [], internal_job_id: id,
    location: { name: loc }, metadata: null, id, updated_at: published, requisition_id: null, title,
    company_name: company, first_published: published, language: 'en',
  })),
  meta: { total: jobs.length },
});

// Lever: a bare array.
export const lever = (company, jobs) => jobs.map(([id, title, loc, createdAt]) => ({
  id, text: title, createdAt, workplaceType: /remote/i.test(loc) ? 'remote' : 'onsite',
  categories: { location: loc, team: 'Engineering', commitment: 'Full-time' },
  hostedUrl: `https://jobs.lever.co/${company}/${id}`, applyUrl: `https://jobs.lever.co/${company}/${id}/apply`,
}));

// Ashby: { jobs: [...] } with the keys seen in a live Kraken response.
export const ashby = (company, jobs) => ({
  apiVersion: '1',
  jobs: jobs.map(([id, title, loc, published, listed = true]) => ({
    id, title, department: 'Engineering', team: 'Protocol', employmentType: 'FullTime', location: loc,
    secondaryLocations: [], publishedAt: published, isListed: listed, isRemote: /remote/i.test(loc),
    workplaceType: /remote/i.test(loc) ? 'Remote' : 'OnSite', address: null,
    jobUrl: `https://jobs.ashbyhq.com/${company}/${id}`, applyUrl: `https://jobs.ashbyhq.com/${company}/${id}/application`,
    descriptionHtml: '<p>…</p>', descriptionPlain: '…',
  })),
});

// web3.career: metadata entries, then the jobs array.
export const web3career = (jobs) => [
  'Terms: link to apply_url',
  'https://web3.career',
  jobs.map(([id, title, company, epoch, location = 'Remote']) => ({
    id, title, date: new Date(epoch * 1000).toUTCString(), date_epoch: String(epoch), country: '', city: '',
    company, location, apply_url: `https://web3.career/${id}`, tags: ['solidity'], description: '…',
  })),
];
