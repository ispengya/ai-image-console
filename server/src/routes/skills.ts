import type { FastifyInstance } from 'fastify';
import { loadSkills } from '../skills/loader.js';

export async function skillRoutes(app: FastifyInstance) {
  app.get('/api/skills', async () => {
    const skills = loadSkills();
    return {
      skills: skills.map((s) => ({
        name: s.name,
        label: s.label,
        description: s.description,
        template: s.template,
        overrides: s.overrides,
        source: s.source,
        enabled: s.enabled,
      })),
    };
  });
}
