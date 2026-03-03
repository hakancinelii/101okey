const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    const defaultGame = await prisma.game.findUnique({
        where: { id: 'default' },
        include: { members: true }
    });
    console.log('Default Game:', JSON.stringify(defaultGame, null, 2));

    // Also check other games
    const activeGames = await prisma.game.findMany({
        where: { status: 'ACTIVE' },
        include: { members: true }
    });
    console.log('Active Games Count:', activeGames.length);
    activeGames.forEach(g => {
        console.log(`Game ${g.id}: ${g.members.length} members`);
    });
}

main().catch(console.error).finally(() => prisma.$disconnect());
