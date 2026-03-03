const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function reset() {
    console.log('Resetting game status to PENDING...');
    await prisma.game.updateMany({
        where: { id: 'default' },
        data: {
            status: 'PENDING',
            startedAt: null,
            tilePool: null
        }
    });

    console.log('Resetting member status...');
    await prisma.gameMember.updateMany({
        where: { gameId: 'default' },
        data: {
            isReady: false,
            hand: null
        }
    });

    console.log('SUCCESS: Default lobby reset. You can now start the game again.');
}

reset().catch(console.error).finally(() => prisma.$disconnect());
