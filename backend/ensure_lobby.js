const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
    const user = await prisma.user.findUnique({ where: { email: 'test@example.com' } });
    if (!user) {
        console.log('User not found');
        return;
    }
    await prisma.game.deleteMany({ where: { id: 'default' } });
    const game = await prisma.game.create({
        data: {
            id: 'default',
            hostId: user.id,
            status: 'PENDING'
        }
    });
    console.log('SUCCESS: Lobby created with ID:', game.id);
}
main().catch(console.error).finally(() => prisma.$disconnect());
