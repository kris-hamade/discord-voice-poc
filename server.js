require('dotenv').config({ path: './.env' });
const { 
    Client, 
    GatewayIntentBits, 
    REST, 
    Routes, 
    Partials 
} = require("discord.js");
const { 
    joinVoiceChannel, 
    createAudioPlayer, 
    createAudioResource, 
    getVoiceConnection, 
    AudioPlayerStatus 
} = require('@discordjs/voice');
const playdl = require('play-dl');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMembers,
    ],
    partials: [Partials.GuildMember, Partials.Channel],
});

const commands = [
    {
        name: "join",
        description: "Join the voice channel you are currently in.",
    },
    {
        name: "play",
        description: "Play a YouTube link in the connected voice channel.",
        options: [
            {
                name: "url",
                type: 3, // STRING type
                description: "The YouTube URL to play.",
                required: true,
            },
        ],
    },
    {
        name: "disconnect",
        description: "Disconnect the bot from the voice channel.",
    },
];

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

client.once("ready", async () => {
    console.log(`Logged in as ${client.user.tag}!`);

    try {
        console.log("Started refreshing application (/) commands.");
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log("Successfully reloaded application (/) commands.");
    } catch (error) {
        console.error("Error registering commands:", error);
    }
});

client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "join") {
        const member = interaction.member;
        const voiceChannel = member.voice.channel;

        if (!voiceChannel) {
            return interaction.reply({
                content: "You need to be in a voice channel to use this command.",
                ephemeral: true,
            });
        }

        try {
            joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: interaction.guild.id,
                adapterCreator: interaction.guild.voiceAdapterCreator,
                selfDeaf: false, // Ensure bot is not deafened
            });

            await interaction.reply("Joined your voice channel!");
        } catch (error) {
            console.error("Error joining voice channel:", error);
            await interaction.reply("Failed to join the voice channel.");
        }
    }

    if (interaction.commandName === "play") {
        const url = interaction.options.getString("url");

        if (!playdl.yt_validate(url)) {
            return interaction.reply({
                content: "Please provide a valid YouTube link.",
                ephemeral: true,
            });
        }

        const connection = getVoiceConnection(interaction.guildId);

        if (!connection) {
            return interaction.reply({
                content: "The bot is not connected to a voice channel. Use /join first.",
                ephemeral: true,
            });
        }

        try {
            const stream = await playdl.stream(url);
            const resource = createAudioResource(stream.stream, { inputType: stream.type });
            const player = createAudioPlayer();

            connection.subscribe(player);
            player.play(resource);

            player.on(AudioPlayerStatus.Idle, () => {
                console.log("Audio finished playing.");
                player.stop();
            });

            await interaction.reply(`Now playing: ${url}`);
        } catch (error) {
            console.error("Error playing YouTube audio:", error);
            await interaction.reply("Failed to play the audio. Please try again.");
        }
    }

    if (interaction.commandName === "disconnect") {
        const connection = getVoiceConnection(interaction.guildId);

        if (!connection) {
            return interaction.reply({
                content: "The bot is not connected to a voice channel.",
                ephemeral: true,
            });
        }

        try {
            connection.destroy(); // Disconnect from the voice channel
            await interaction.reply("Disconnected from the voice channel.");
        } catch (error) {
            console.error("Error disconnecting:", error);
            await interaction.reply("Failed to disconnect. Please try again.");
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
