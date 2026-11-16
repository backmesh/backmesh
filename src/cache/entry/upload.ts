// Run by runner-job after the job: `node upload.mjs <plan.json>`.
import { upload } from '../snapshot.js';

await upload(process.argv[2]!);
