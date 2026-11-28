import results from '../../public/llmcomp/results.json';

// Whether /llmcomp/results.json has a run's answers: until then the page
// shows only the estimates, without the sample prompts.
export const sampled = results.date !== null;
