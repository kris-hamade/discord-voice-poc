require('dotenv').config();
const path = require('path');
const fs = require('fs');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  Partials,
} = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  getVoiceConnection,
  AudioPlayerStatus,
} = require('@discordjs/voice');
const ytdl = require('@distube/ytdl-core'); // <--- Notice @distube version

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.GuildMember, Partials.Channel],
});

// Slash command definitions
const commands = [
  {
    name: 'join',
    description: 'Join the voice channel you are currently in.',
  },
  {
    name: 'play',
    description: 'Play a YouTube link in the connected voice channel.',
    options: [
      {
        name: 'url',
        type: 3, // STRING
        description: 'The YouTube URL to play.',
        required: true,
      },
    ],
  },
  {
    name: 'disconnect',
    description: 'Disconnect the bot from the voice channel.',
  },
  {
    name: 'testlocal',
    description: 'Play a local test MP3 file.',
  },
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}!`);

  try {
    console.log('Started refreshing application (/) commands...');
    await rest.put(Routes.applicationCommands(client.user.id), {
      body: commands,
    });
    console.log('Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error('Error registering commands:', error);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // --------------------------- JOIN COMMAND ---------------------------
  if (interaction.commandName === 'join') {
    const member = interaction.member;
    const voiceChannel = member.voice.channel;

    if (!voiceChannel) {
      return interaction.reply({
        content: 'You need to be in a voice channel to use this command.',
        ephemeral: true,
      });
    }

    try {
      joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: interaction.guild.id,
        adapterCreator: interaction.guild.voiceAdapterCreator,
        selfDeaf: false,
      });
      await interaction.reply(`Joined your voice channel: ${voiceChannel.name}`);
    } catch (error) {
      console.error('Error joining voice channel:', error);
      await interaction.reply('Failed to join the voice channel.');
    }
  }

  // --------------------------- PLAY COMMAND ---------------------------
  if (interaction.commandName === 'play') {
    const url = interaction.options.getString('url');

    // Validate link
    if (!ytdl.validateURL(url)) {
      return interaction.reply({
        content: 'Please provide a valid YouTube link.',
        ephemeral: true,
      });
    }

    const connection = getVoiceConnection(interaction.guildId);
    if (!connection) {
      return interaction.reply({
        content: 'Bot is not connected to a voice channel. Use /join first.',
        ephemeral: true,
      });
    }

    try {
      // Create stream
      const stream = ytdl(url, { filter: 'audioonly' });

      const resource = createAudioResource(stream);

      let player = connection.state.subscription?.player;
      if (!player) {
        player = createAudioPlayer();
        connection.subscribe(player);
      }

      // Debug logs
      player.on(AudioPlayerStatus.Playing, () => {
        console.log('AudioPlayerStatus: Playing');
      });
      player.on(AudioPlayerStatus.Buffering, () => {
        console.log('AudioPlayerStatus: Buffering');
      });
      player.on(AudioPlayerStatus.Paused, () => {
        console.log('AudioPlayerStatus: Paused');
      });
      player.on(AudioPlayerStatus.Idle, () => {
        console.log('AudioPlayerStatus: Idle (finished or no more data)');
      });
      player.on('error', (err) => {
        console.error('Audio player error:', err);
      });

      // Play!
      player.play(resource);

      await interaction.reply(`Now playing: ${url}`);
    } catch (error) {
      console.error('Error playing YouTube audio:', error);
      await interaction.reply('Failed to play the audio. Please try again.');
    }
  }

  // --------------------------- TESTLOCAL COMMAND ---------------------------
  if (interaction.commandName === 'testlocal') {
    const connection = getVoiceConnection(interaction.guildId);
    if (!connection) {
      return interaction.reply({
        content: 'Bot not connected, /join first.',
        ephemeral: true,
      });
    }

    try {
      let player = connection.state.subscription?.player;
      if (!player) {
        player = createAudioPlayer();
        connection.subscribe(player);
      }

      player.on(AudioPlayerStatus.Playing, () => {
        console.log('AudioPlayerStatus: Playing (local file)');
      });
      player.on(AudioPlayerStatus.Buffering, () => {
        console.log('AudioPlayerStatus: Buffering (local file)');
      });
      player.on(AudioPlayerStatus.Paused, () => {
        console.log('AudioPlayerStatus: Paused (local file)');
      });
      player.on(AudioPlayerStatus.Idle, () => {
        console.log('AudioPlayerStatus: Idle (local file finished)');
      });
      player.on('error', (err) => {
        console.error('Audio player error (local file):', err);
      });

      const audioPath = path.join(__dirname, 'test.mp3');
      const resource = createAudioResource(fs.createReadStream(audioPath));

      player.play(resource);

      await interaction.reply('Playing local MP3!');
    } catch (error) {
      console.error('Error playing local file:', error);
      await interaction.reply('Could not play local file. Check logs.');
    }
  }

  // --------------------------- DISCONNECT COMMAND ---------------------------
  if (interaction.commandName === 'disconnect') {
    const connection = getVoiceConnection(interaction.guildId);

    if (!connection) {
      return interaction.reply({
        content: 'The bot is not connected to a voice channel.',
        ephemeral: true,
      });
    }

    try {
      connection.destroy();
      await interaction.reply('Disconnected from the voice channel.');
    } catch (error) {
      console.error('Error disconnecting:', error);
      await interaction.reply('Failed to disconnect. Please try again.');
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
