// The sample prompts /llmcomp/ shows real answers for: one of each kind of
// everyday task, short enough that a monthly run of every model costs cents.
export const SAMPLES: { id: string; title: string; prompt: string }[] = [
  {
    id: 'summarize',
    title: 'Summarize an email thread',
    prompt: `Summarize this thread in three bullet points, then list who owes what by when.

From: Dana
The vendor moved the delivery of the new laptops from March 3 to March 17. That pushes the onboarding of the four new hires. Can we borrow machines from the lab until then?

From: Sam
The lab has three spare laptops, not four. I can wipe them by Friday. Priya, can IT image the fourth from the old stock?

From: Priya
Yes, I'll have one from the old stock imaged by Monday the 3rd. Dana, please send me the new hires' names today so I can make their accounts.

From: Dana
Sending the names now. Sam, thanks. I'll tell the hiring managers about the delay.`,
  },
  {
    id: 'code-fix',
    title: 'Fix a bug in code',
    prompt: `This function should return the n-th Fibonacci number (fib(0) = 0, fib(1) = 1), but fib(10) returns 89 instead of 55. Find the bug, explain it in one sentence, and give the fixed code.

\`\`\`python
def fib(n):
    a, b = 0, 1
    for _ in range(n + 1):
        a, b = b, a + b
    return a
\`\`\``,
  },
  {
    id: 'extract',
    title: 'Extract data as JSON',
    prompt: `Extract every order from this text as a JSON array of objects with "customer", "item", "quantity" (a number) and "date" (YYYY-MM-DD). Reply with the JSON only.

On 4 March 2026 Ana Ruiz ordered two standing desks. Two days later, Tom Becker bought a monitor arm, and Ana came back for three more chairs on the 9th. Lee Wong's order of 12 cable trays went in on March 11.`,
  },
  {
    id: 'reasoning',
    title: 'Solve a logic puzzle',
    prompt: `Three friends, Ava, Ben and Cal, each own one pet: a cat, a dog or a parrot. Ava doesn't own the dog. The parrot's owner is older than Ben. Cal is the youngest. Who owns which pet? Show your reasoning briefly.`,
  },
  {
    id: 'math',
    title: 'Work out a word problem',
    prompt: `A train leaves at 9:40 and travels 210 km at an average of 84 km/h, then stops for 12 minutes, then travels another 95 km at 76 km/h. When does it arrive? Show the steps.`,
  },
  {
    id: 'email',
    title: 'Write a polite email',
    prompt: `Write a short, friendly email to a customer whose order of 40 printed mugs will ship one week late because the printer broke. Offer free shipping on their next order. Keep it under 120 words.`,
  },
  {
    id: 'rewrite',
    title: 'Rewrite for plain language',
    prompt: `Rewrite this for a general reader, in two short sentences:

"Pursuant to the revised policy, employees are hereby required to submit all expenditure reimbursement requests no later than thirty (30) calendar days subsequent to the date on which the expenditure was incurred, failing which such requests shall be deemed ineligible for processing."`,
  },
  {
    id: 'translate',
    title: 'Translate into three languages',
    prompt: `Translate into Spanish, French and German, one line each: "The meeting moved to Thursday at 3 pm. Please bring the signed contract."`,
  },
  {
    id: 'classify',
    title: 'Classify support tickets',
    prompt: `Label each ticket as "billing", "bug", "feature request" or "account". Reply as a numbered list of labels only.

1. I was charged twice this month.
2. The export button does nothing in Firefox.
3. Could you add a dark mode?
4. I can't log in since I changed my email.
5. Please send an invoice with our VAT number on it.`,
  },
  {
    id: 'sql',
    title: 'Write a SQL query',
    prompt: `Tables: customers(id, name, country) and orders(id, customer_id, total, created_at). Write a PostgreSQL query for the five customers who spent the most in 2026, with their name, country and total spent, highest first.`,
  },
  {
    id: 'regex',
    title: 'Write a regular expression',
    prompt: `Write a regular expression that matches a US ZIP code, either 5 digits or 5 digits, a hyphen and 4 digits, and nothing else. Give two strings it matches and two it doesn't.`,
  },
  {
    id: 'explain',
    title: 'Explain a concept simply',
    prompt: `Explain to a 12-year-old what an API is, in under 100 words, with one everyday example.`,
  },
  {
    id: 'ideas',
    title: 'Brainstorm names',
    prompt: `Suggest eight names for a small bakery that specializes in sourdough, each with a one-line reason.`,
  },
  {
    id: 'review',
    title: 'Review a pull request change',
    prompt: `Review this change and point out any problem in one or two sentences each.

\`\`\`js
- const users = await db.query('SELECT * FROM users WHERE id = $1', [id]);
+ const users = await db.query(\`SELECT * FROM users WHERE id = \${id}\`);
\`\`\``,
  },
];
