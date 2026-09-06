import './_bootstrap-env';
import { asSystem, closeConnections } from '@/lib/db';
import { PROGRAM_DEFAULT_TARGETS } from '@/lib/domain/program';

/**
 * Baseline seed data.
 *
 * This is safe to run against any environment, including production:
 *  - No user accounts, credentials, OTPs or sessions.
 *  - No lead or prospect data of any kind. Real prospect data only ever enters
 *    through the admin import wizard in a private environment.
 *  - Only program scaffolding an admin would otherwise have to type by hand:
 *    territories, the state -> territory map, training topics, and clearly
 *    labelled starter script templates.
 *
 * Every statement is idempotent, so re-running it never duplicates rows.
 */

const EAST_STATES = [
  'CT',
  'DE',
  'DC',
  'FL',
  'GA',
  'ME',
  'MD',
  'MA',
  'NH',
  'NJ',
  'NY',
  'NC',
  'PA',
  'RI',
  'SC',
  'VT',
  'VA',
  'WV',
  'OH',
  'MI',
  'IN',
  'KY',
  'TN',
  'AL',
  'MS',
  'IL',
  'WI',
];

const WEST_STATES = [
  'AK',
  'AZ',
  'AR',
  'CA',
  'CO',
  'HI',
  'ID',
  'IA',
  'KS',
  'LA',
  'MN',
  'MO',
  'MT',
  'NE',
  'NV',
  'NM',
  'ND',
  'OK',
  'OR',
  'SD',
  'TX',
  'UT',
  'WA',
  'WY',
];

const TRAINING_TOPICS = [
  [
    'org_research',
    'Finding organizations to contact',
    'How to build a list of clubs and leagues worth approaching.',
  ],
  [
    'decision_maker_research',
    'Finding the right person within an organization',
    'Identifying the director, president or commissioner who can actually say yes.',
  ],
  [
    'scripts',
    'Using the email and LinkedIn scripts',
    'Working from the supplied templates without sounding templated.',
  ],
  [
    'personalization',
    'Personalizing your messages',
    'The specific details that make a cold message read as researched.',
  ],
  [
    'follow_ups',
    'Following up with prospects',
    'Cadence, timing, and what to say on the second and third touch.',
  ],
  [
    'interested_responses',
    'Responding when someone shows interest',
    'Turning a positive reply into a scheduled conversation.',
  ],
  ['booking_meetings', 'Booking a meeting', 'Proposing times, confirming, and reducing no-shows.'],
  [
    'outreach_tracking',
    'Keeping track of your outreach',
    'Logging every send in this workspace so the team never double-contacts a club.',
  ],
  [
    'platform_walkthrough',
    'Waresport platform walkthrough',
    'What Waresport does, who it is for, and why clubs switch to it.',
  ],
] as const;

const STARTER_RESOURCES = [
  {
    title: 'Cold email — first touch (starter example)',
    category: 'email_script',
    summary: 'A short first-touch email. Replace the bracketed parts with real research.',
    body: `Subject: quick question about [CLUB NAME]'s [SEASON] registration

Hi [FIRST NAME],

I saw [SPECIFIC DETAIL — e.g. that you run both rec and travel programs out of
[FACILITY]]. Most clubs that size end up running registration, scheduling and
payments across three or four different tools.

Waresport puts those in one place. Clubs your size usually save the board a few
hours a week and stop chasing parents for payment.

Worth a 15-minute look next week? I can work around your schedule.

[YOUR NAME]
Waresport`,
  },
  {
    title: 'Cold email — follow-up (starter example)',
    category: 'email_script',
    summary: 'Second touch, sent 3–4 days after the first. Adds a reason to reply.',
    body: `Subject: re: [CLUB NAME] registration

Hi [FIRST NAME],

Following up on the note below in case it got buried.

One thing worth a minute: [SPECIFIC PROBLEM YOU NOTICED — e.g. registration
currently runs through a Google Form and a separate payment link].

If this is not the right time, just say so and I will stop following up.

[YOUR NAME]`,
  },
  {
    title: 'LinkedIn connection note (starter example)',
    category: 'linkedin_script',
    summary: 'Under 300 characters, the LinkedIn connection-request limit.',
    body: `Hi [FIRST NAME] — I work with youth [SPORT] organizations on registration and
scheduling software. Saw you run [CLUB NAME]. Would like to connect and hear how
your [SEASON] went.`,
  },
  {
    title: 'LinkedIn message after connecting (starter example)',
    category: 'linkedin_script',
    summary: 'Sent only after the connection is accepted — a separate, later event.',
    body: `Thanks for connecting, [FIRST NAME].

Quick context: Waresport is an all-in-one platform for club management —
registration, scheduling, payments and team communication in one place.

What are you using for registration right now? If it is working, genuinely no
pitch. If it is three tools stitched together, worth 15 minutes.`,
  },
  {
    title: 'Personalization checklist',
    category: 'personalization',
    summary: 'Find at least two of these before sending anything.',
    body: `Before you send, find at least two of:

1. The club's actual size — number of teams, age brackets, rec vs travel.
2. What they currently use — look at the registration link on their site.
3. Something recent — a tournament, a facility change, a season announcement.
4. The person's actual role — president, commissioner, registrar, board member.

If you cannot find two, the message is not ready. Log it as research, not as
outreach.`,
  },
  {
    title: 'What counts as outreach in this workspace',
    category: 'training',
    summary: 'Read this before your first day of logging.',
    body: `Only messages you actually sent count.

- Writing a draft is not outreach. Log it as a research note.
- Copying an email address is not outreach.
- Opening a LinkedIn profile is not outreach.
- Adding a prospect to the LinkedIn tracker is not outreach.

An email counts once you have sent it from your Waresport address. A LinkedIn
connection request counts once you have actually sent the request — and only
the first time for any one profile. Accepting a connection and messaging
afterwards are separate events that are tracked but do not count again toward
the weekly connection-request goal.

Everything you log here is self-reported. Log it honestly and log it the same
day.`,
  },
] as const;

async function main() {
  await asSystem(async (tx) => {
    // --- territories -------------------------------------------------------
    await tx`
      INSERT INTO territories (code, name, description) VALUES
        ('EAST', 'East', 'Eastern United States. Three interns per the program guide.'),
        ('WEST', 'West', 'Western United States. Three interns per the program guide.')
      ON CONFLICT (code) DO NOTHING`;

    const territories = await tx<{ id: string; code: string }[]>`
      SELECT id, code FROM territories WHERE code IN ('EAST', 'WEST')`;
    const east = territories.find((t) => t.code === 'EAST')!;
    const west = territories.find((t) => t.code === 'WEST')!;

    // The program guide does not define a state -> territory map, so this is a
    // documented default that an admin can edit in Settings.
    for (const [states, territory] of [
      [EAST_STATES, east],
      [WEST_STATES, west],
    ] as const) {
      await tx`
        INSERT INTO territory_states (state_code, territory_id)
        SELECT s, ${territory.id} FROM unnest(${states}::text[]) AS s
        ON CONFLICT (state_code) DO NOTHING`;
    }

    // --- training topics ---------------------------------------------------
    for (const [index, [key, title, description]] of TRAINING_TOPICS.entries()) {
      await tx`
        INSERT INTO training_topics (key, title, description, sort_order)
        VALUES (${key}, ${title}, ${description}, ${(index + 1) * 10})
        ON CONFLICT (key) DO UPDATE
          SET title = EXCLUDED.title,
              description = EXCLUDED.description,
              sort_order = EXCLUDED.sort_order`;
    }

    // --- starter resources -------------------------------------------------
    for (const [index, resource] of STARTER_RESOURCES.entries()) {
      const [existing] = await tx<{ id: string }[]>`
        SELECT id FROM resources WHERE title = ${resource.title} LIMIT 1`;
      if (existing !== undefined) continue;
      await tx`
        INSERT INTO resources
          (title, category, summary, body_markdown, is_starter_example, audience, sort_order)
        VALUES (
          ${resource.title},
          ${resource.category}::resource_category,
          ${resource.summary},
          ${resource.body},
          true,
          'all',
          ${(index + 1) * 10}
        )`;
    }

    console.info(
      `Seeded ${territories.length} territories, ${TRAINING_TOPICS.length} training topics, ${STARTER_RESOURCES.length} starter resources.`,
    );
    console.info(
      `Program defaults available: week 1 = ${PROGRAM_DEFAULT_TARGETS.week1.emails} emails / ` +
        `${PROGRAM_DEFAULT_TARGETS.week1.linkedin} requests; weeks 2-12 = ` +
        `${PROGRAM_DEFAULT_TARGETS.laterWeeks.emails} / ${PROGRAM_DEFAULT_TARGETS.laterWeeks.linkedin}.`,
    );
    console.info('No accounts and no lead data were created. Bootstrap an owner next:');
    console.info('  npm run bootstrap:owner -- --email <your address>');
  });
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeConnections());
