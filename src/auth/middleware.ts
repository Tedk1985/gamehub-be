import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify();
  } catch {
    reply.status(401).send({ error: 'Unauthorized' });
  }
}

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify();
    const user = request.user as { role: string };
    if (user.role !== 'admin') {
      reply.status(403).send({ error: 'Forbidden' });
    }
  } catch {
    reply.status(401).send({ error: 'Unauthorized' });
  }
}
