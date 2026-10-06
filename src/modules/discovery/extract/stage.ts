import { db, withTenant } from '../../../db/client.js';
import { env } from '../../../env.js';
import { companyLookup, normalizeDomain, normalizeName, upsert, type RawIdentifier } from '../../../spine/registry/index.js';
import { ask, releaseClaudeCall, reserveClaudeCall } from '../claude.js';
import { PermanentError, UsageLimitError } from '../errors.js';
import { setProfile } from '../index.js';
import type { Counts, JobRow, PersonaRow, TaskRow } from '../jobs.js';
import { Extraction, extractPrompt } from '../prompts.js';
import { contactsIn, readSite } from '../read/index.js';
import { personasOf } from '../search/stages.js';
import { checkExtraction, sameName, type Source } from './check.js';

/**
 * `read_extract`: for each kept candidate, in triage order, read its pages
 * into memory, have Claude extract what it is, check every quote against the
 * pages, save it to the pool, and mark the candidate before the next one. The
 * pages go with it: nothing read is ever stored, only checked quotes.
 *
 * One stage rather than two, because a stored page is what a separate extract
 * stage would need after a retry. A retry or a deferral carries on from the
 * first candidate not yet marked.
 */

const FRESH_DAYS = 90;

type CandidateRow = {
  id: string;
  kind: 'web' | 'maps' | 'both';
  domain: string | null;
  gmaps: string | null;
  name: string;
  url: string | null;
  phone: string | null;
  address: string | null;
  category: string | null;
  persona_ids: string[];
  fit: 'strong' | 'weak' | null;
  company_id: string | null;
};

/** Add to the task's counts as it goes, so a deferral loses nothing. */
async function bump(task: TaskRow, add: Counts): Promise<void> {
  const keys = Object.keys(add);
  if (keys.length === 0) return;
  await withTenant(task.tenant_id, (tx) => tx`
    update discovery_tasks set counts = counts || (
      select jsonb_object_agg(k, coalesce((counts->>k)::int, 0) + v)
      from jsonb_each_text(${tx.json(add)}) as a (k, v_text)
      cross join lateral (select a.v_text::int as v) n
    )
    where id = ${task.id}
  `);
}

async function mark(
  task: TaskRow,
  candidateId: string,
  fields: {
    status: 'extracted' | 'not_saved' | 'failed';
    reason: string;
    companyId?: string | null;
    personaId?: string | null;
    fit?: 'strong' | 'weak' | null;
    evidence?: unknown[];
  },
): Promise<void> {
  await withTenant(task.tenant_id, (tx) => tx`
    update discovery_candidates set
      status = ${fields.status},
      reason = ${fields.reason.slice(0, 240)},
      company_id = coalesce(${fields.companyId ?? null}::uuid, company_id),
      persona_ids = case when ${fields.personaId ?? null}::uuid is null then persona_ids
                         else array[${fields.personaId ?? null}::uuid] end,
      fit = coalesce(${fields.fit ?? null}, fit),
      evidence = ${tx.json((fields.evidence ?? []) as never)}
    where id = ${candidateId} and task_id = ${task.id}
  `);
}

export async function runReadExtract(job: JobRow, task: TaskRow): Promise<Counts> {
  const e = env();
  const personas = await personasOf(job);

  const [pending, done] = await withTenant(job.tenant_id, async (tx) => [
    await tx<CandidateRow[]>`
      select id::text, kind, domain, gmaps, name, url, phone, address, category,
             persona_ids::text[] as persona_ids, fit, company_id::text
      from discovery_candidates
      where task_id = ${task.id} and status = 'kept'
      order by case fit when 'strong' then 0 when 'weak' then 1 else 2 end, created_at, id
    `,
    await tx<{ n: number }[]>`
      select count(*)::int as n from discovery_candidates
      where task_id = ${task.id} and status in ('extracted', 'not_saved', 'failed')
        and coalesce(reason, '') <> 'profile fresh: not re-read'
    `,
  ]);
  let processed = done[0]?.n ?? 0;

  // Fresh ones first: profiled from the web lately, before this job began.
  // They are ranked from what is stored, and never count against the caps.
  const toRead: CandidateRow[] = [];
  for (const c of pending) {
    if (c.company_id && (await profiledFreshBefore(c.company_id, job.created_at))) {
      await mark(task, c.id, { status: 'extracted', reason: 'profile fresh: not re-read' });
      await bump(task, { read_skipped_fresh: 1 });
    } else {
      toRead.push(c);
    }
  }

  for (let i = 0; i < toRead.length; i += 1) {
    const c = toRead[i]!;
    if (processed >= e.DISCOVERY_MAX_READS) {
      await bump(task, { reads_capped: toRead.length - i });
      break;
    }
    processed += 1;

    try {
      const outcome = await readAndExtract(job, task, c, personas);
      if (outcome === 'budget') {
        await bump(task, { extract_capped: toRead.length - i });
        break;
      }
    } catch (err) {
      if (err instanceof UsageLimitError || err instanceof PermanentError) throw err;
      await mark(task, c.id, { status: 'failed', reason: 'could not read or extract' });
      await bump(task, { extract_failed: 1 });
    }
  }

  return {};
}

/**
 * Profiled from the web within FRESH_DAYS, and before this job began: a
 * company this very job saved a minute ago is not "fresh", it is found.
 * profiled_at is only stamped when web pages were actually read.
 */
async function profiledFreshBefore(companyId: string, jobStarted: Date): Promise<boolean> {
  const [row] = await db()<{ fresh: boolean }[]>`
    select profiled_at > now() - make_interval(days => ${FRESH_DAYS}) and profiled_at < ${jobStarted} as fresh
    from company_profiles where company_id = ${companyId}
  `;
  return row?.fresh === true;
}

async function readAndExtract(
  job: JobRow,
  task: TaskRow,
  c: CandidateRow,
  personas: PersonaRow[],
): Promise<'done' | 'budget'> {
  // The budget first, so a spent one costs no reading.
  if (!(await reserveClaudeCall(job.tenant_id, job.id))) return 'budget';

  // The pages, in memory only.
  const sources: Source[] = [];
  if (c.domain) {
    const read = await readSite({ url: c.url, domain: c.domain });
    sources.push(...read.pages);
    await bump(task, {
      read: read.pages.length > 0 ? 1 : 0,
      read_failed: read.pages.length === 0 ? 1 : 0,
      firecrawl: read.firecrawl,
      fetch_fallback: read.fetchFallback,
    });
  }
  const listingUrl = c.gmaps ? `https://maps.google.com/?cid=${c.gmaps}` : null;
  if (listingUrl) {
    sources.push({
      url: listingUrl,
      text: [c.name, c.category, c.address, c.phone].filter(Boolean).join('\n'),
    });
  }
  // A website counts only if it was read. A listing whose site could not be
  // read is judged as the listing alone, with no claim to that domain.
  const siteRead = sources.some((s) => s.url !== listingUrl);
  if (!siteRead && !listingUrl) {
    await releaseClaudeCall(job.tenant_id, job.id);
    await mark(task, c.id, { status: 'failed', reason: 'the site could not be read' });
    return 'done';
  }
  await bump(task, { claude_calls: 1 });

  const raw = await ask('extract', {
    system: extractPrompt.system,
    schema: extractPrompt.schema,
    input: JSON.stringify({
      side: job.side,
      country: task.country,
      product: job.identified
        ? { name: job.identified.name, category: job.identified.category, description: job.identified.description }
        : { name: job.product },
      personas: personas.map((p) => ({ id: p.id, name: p.name, description: p.description, signals: p.signals })),
      listing: listingUrl
        ? { url: listingUrl, title: c.name, category: c.category, address: c.address, phone: c.phone }
        : null,
      pages: sources.filter((s) => s.url !== listingUrl),
    }),
  });
  const parsed = Extraction.safeParse(raw);
  if (!parsed.success) throw new Error('claude bridge: extract answer out of shape');

  const result = checkExtraction(parsed.data, {
    sources,
    personas: personas.map((p) => ({ id: p.id, signals: p.signals })),
    listingTitle: siteRead ? null : c.name,
    listingUrl: siteRead ? null : listingUrl,
  });
  await bump(task, {
    extracted: 1,
    quotes_checked: result.quotesChecked,
    quotes_dropped: result.quotesDropped,
  });

  if (!result.saved) {
    await mark(task, c.id, { status: 'not_saved', reason: result.reason });
    await bump(task, { not_saved: 1 });
    return 'done';
  }

  // Contacts are verbatim pattern matches on what was read, never Claude's.
  const text = sources.map((s) => s.text).join('\n');
  const contacts = contactsIn(text, { country: task.country });
  const phones = [...new Set([...contacts.phones, ...contacts.whatsapp])];
  // An address on the company's own domain says who it is. Any other one a
  // page prints (a partner's, a parent's, a web agency's) would bring that
  // domain along as a strong identifier and could merge two companies.
  const emails = c.domain && siteRead
    ? contacts.emails.filter((email) => normalizeDomain(email.slice(email.indexOf('@') + 1)) === c.domain)
    : [];
  // A Maps listing joined this candidate because its website field named the
  // domain, which anyone can type. Its Maps id says who the company is only
  // when there is no site, or the listing carries the name that was saved.
  const gmapsIsIt = c.gmaps !== null && (!siteRead || sameName(c.name, result.name.value));
  const identifiers: RawIdentifier[] = [
    ...(c.domain && siteRead ? [{ type: 'domain', value: c.domain }] : []),
    ...(gmapsIsIt ? [{ type: 'gmaps', value: c.gmaps! }] : []),
    ...(c.phone ? [{ type: 'phone', value: c.phone }] : []),
    ...phones.map((value) => ({ type: 'phone', value })),
    ...emails.map((value) => ({ type: 'email', value })),
  ];

  // A CR printed on a page could be anyone's, and a CR is strong: it only
  // becomes an identifier when the registrar names the same company.
  const crClaimed = siteRead ? (contacts.crs[0] ?? null) : null;
  if (crClaimed && (await registrarAgrees(crClaimed, result.name.value))) {
    identifiers.push({ type: 'cr', value: crClaimed });
  }

  const quotes = [
    { field: 'name', quote: result.name.quote, url: result.name.url },
    ...(result.nameAr ? [{ field: 'nameAr', quote: result.nameAr.quote, url: result.nameAr.url }] : []),
    ...result.products.map((p) => ({ field: 'product', quote: p.quote, url: p.url })),
    ...result.cities.map((p) => ({ field: 'city', quote: p.quote, url: p.url })),
    ...result.evidence.map((p) => ({ field: 'evidence', quote: p.quote, url: p.url })),
  ];
  const quality = result.products.length > 0 && identifiers.some((i) => i.type === 'phone' || i.type === 'email') ? 'full' : 'thin';

  const saved = await withTenant(job.tenant_id, async (tx) => {
    const { company } = await upsert(tx, {
      name: result.name.value,
      country: task.country,
      identifiers,
      defaultCountry: task.country,
      linkByName: false,
      source: {
        type: siteRead ? 'web' : 'maps',
        ref: (siteRead ? c.url : listingUrl) ?? undefined,
        tenantId: job.tenant_id,
        data: {
          jobId: job.id,
          personaId: result.personaId,
          url: siteRead ? c.url : listingUrl,
          quotes,
          ...(crClaimed ? { crClaimed } : {}),
          ...(c.gmaps && !gmapsIsIt ? { listingCid: c.gmaps } : {}),
        },
      },
    });
    await setProfile(tx, {
      tenantId: job.tenant_id,
      companyId: company.id,
      merge: true,
      products: result.products.map((p) => p.value),
      roles: result.roles,
      cities: result.cities.map((p) => p.value),
      countries: [task.country],
      quality,
      // Stamped only when web pages were read: a listing is not a profile.
      ...(siteRead ? { profiledAt: new Date() } : {}),
    });
    return company;
  });

  await mark(task, c.id, {
    status: 'extracted',
    reason: result.reason || 'saved',
    companyId: saved.id,
    personaId: result.personaId,
    fit: result.fit,
    evidence: result.evidence,
  });
  await bump(task, { saved: 1 });
  return 'done';
}

/** Whether Wathq (when configured) names this CR's company as we did. */
async function registrarAgrees(cr: string, name: string): Promise<boolean> {
  const lookup = companyLookup();
  if (!lookup) return false;
  const facts = await lookup.byCr(cr).catch(() => null);
  if (!facts?.name) return false;
  const a = normalizeName(facts.name);
  const b = normalizeName(name);
  return a.length > 0 && b.length > 0 && a === b;
}
