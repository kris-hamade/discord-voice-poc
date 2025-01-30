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
const ytdl = require('@distube/ytdl-core'); // or use 'ytdl-core'

// How many seconds to stay idle before automatically disconnecting
const DISCONNECT_AFTER_IDLE = parseInt(process.env.AUTO_DISCONNECT_SECONDS, 10) || 30;

// Store idle timers per guild, in case your bot is in multiple guilds at once
const idleTimers = new Map();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.GuildMember, Partials.Channel],
});

// ---------------------------------
// Slash command definitions
// ---------------------------------
const commands = [
  // Removed the /join command entirely
  {
    name: 'play',
    description: 'Play a YouTube link in the connected voice channel (auto-joins if needed).',
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
    name: 'stop',
    description: 'Stop the current playback, but remain in the channel.',
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

  // Register slash commands
  try {
    console.log('Started refreshing application (/) commands...');
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error('Error registering commands:', error);
  }
});

// ----------------------------------------------------------------------
// Helper: Manage Idle Timer
// ----------------------------------------------------------------------
function clearIdleTimer(guildId) {
  if (idleTimers.has(guildId)) {
    clearTimeout(idleTimers.get(guildId));
    idleTimers.delete(guildId);
  }
}

function startIdleTimer(connection, guildId) {
  clearIdleTimer(guildId); // Clear any existing timer

  const timer = setTimeout(() => {
    console.log(`Idle for ${DISCONNECT_AFTER_IDLE} seconds in guild ${guildId}, disconnecting...`);
    connection.destroy(); // Disconnect
  }, DISCONNECT_AFTER_IDLE * 1000);

  idleTimers.set(guildId, timer);
}

// ----------------------------------------------------------------------
// Main command handling
// ----------------------------------------------------------------------
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // --------------------------- PLAY COMMAND ---------------------------
  if (interaction.commandName === 'play') {
    const url = interaction.options.getString('url');
    console.log('Received play command with URL:', url);

    const member = interaction.member;
    const voiceChannel = member.voice.channel;
    if (!voiceChannel) {
      return interaction.reply({
        content: 'You need to be in a voice channel to use this command.',
        ephemeral: true,
      });
    }

    // Validate link
    if (!ytdl.validateURL(url)) {
      return interaction.reply({
        content: 'Please provide a valid YouTube link.',
        ephemeral: true,
      });
    }

    // Check if already connected; if not, join now
    let connection = getVoiceConnection(interaction.guildId);
    if (!connection) {
      // Join the user's voice channel
      connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: interaction.guild.id,
        adapterCreator: interaction.guild.voiceAdapterCreator,
        selfDeaf: false,
      });
    }

    try {
      // Create ytdl stream
      const stream = ytdl(url, { filter: 'audioonly' });
      // Create resource
      const resource = createAudioResource(stream);

      // Use existing audio player or create a new one
      let player = connection.state.subscription?.player;
      if (!player) {
        player = createAudioPlayer();
        connection.subscribe(player);

        // Set up status listeners (only do this once per guild/player)
        player.on(AudioPlayerStatus.Playing, () => {
          console.log('AudioPlayerStatus: Playing');
          // If we start playing, cancel any idle-disconnect timer
          clearIdleTimer(interaction.guildId);
        });

        player.on(AudioPlayerStatus.Idle, () => {
          console.log('AudioPlayerStatus: Idle (finished or no more data)');
          // Start idle timer to disconnect automatically
          startIdleTimer(connection, interaction.guildId);
        });

        player.on(AudioPlayerStatus.Buffering, () => {
          console.log('AudioPlayerStatus: Buffering');
        });
        player.on(AudioPlayerStatus.Paused, () => {
          console.log('AudioPlayerStatus: Paused');
        });
        player.on('error', (err) => {
          console.error('Audio player error:', err);
        });
      }

      // Start playback
      player.play(resource);

      await interaction.reply(`Now playing: ${url}`);
    } catch (error) {
      console.error('Error playing YouTube audio:', error);
      await interaction.reply('Failed to play the audio. Please try again.');
    }
  }

  // --------------------------- STOP COMMAND ---------------------------
  if (interaction.commandName === 'stop') {
    const connection = getVoiceConnection(interaction.guildId);

    if (!connection) {
      return interaction.reply({
        content: 'I am not connected to a voice channel right now.',
        ephemeral: true,
      });
    }

    const player = connection.state.subscription?.player;
    if (!player) {
      return interaction.reply({
        content: 'Nothing is currently playing!',
        ephemeral: true,
      });
    }

    try {
      player.stop(true); // Force stop
      await interaction.reply('Playback has been **stopped**.');
      // Bot remains in voice; now it's idle, so we start the idle timer
      startIdleTimer(connection, interaction.guildId);
    } catch (error) {
      console.error('Error stopping playback:', error);
      await interaction.reply('Failed to stop playback. Check console logs.');
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
      // Clear any idle timer
      clearIdleTimer(interaction.guildId);
      connection.destroy();
      await interaction.reply('Disconnected from the voice channel.');
    } catch (error) {
      console.error('Error disconnecting:', error);
      await interaction.reply('Failed to disconnect. Please try again.');
    }
  }

  // --------------------------- TESTLOCAL COMMAND ---------------------------
  if (interaction.commandName === 'testlocal') {
    const member = interaction.member;
    const voiceChannel = member.voice.channel;

    if (!voiceChannel) {
      return interaction.reply({
        content: 'You need to be in a voice channel first.',
        ephemeral: true,
      });
    }

    let connection = getVoiceConnection(interaction.guildId);
    if (!connection) {
      connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: interaction.guild.id,
        adapterCreator: interaction.guild.voiceAdapterCreator,
        selfDeaf: false,
      });
    }

    try {
      let player = connection.state.subscription?.player;
      if (!player) {
        player = createAudioPlayer();
        connection.subscribe(player);

        player.on(AudioPlayerStatus.Playing, () => {
          console.log('AudioPlayerStatus: Playing (local file)');
          clearIdleTimer(interaction.guildId);
        });
        player.on(AudioPlayerStatus.Idle, () => {
          console.log('AudioPlayerStatus: Idle (local file finished)');
          startIdleTimer(connection, interaction.guildId);
        });
        player.on(AudioPlayerStatus.Buffering, () => {
          console.log('AudioPlayerStatus: Buffering (local file)');
        });
        player.on(AudioPlayerStatus.Paused, () => {
          console.log('AudioPlayerStatus: Paused (local file)');
        });
        player.on('error', (err) => {
          console.error('Audio player error (local file):', err);
        });
      }

      const audioPath = path.join(__dirname, 'test.mp3');
      const resource = createAudioResource(fs.createReadStream(audioPath));

      player.play(resource);
      await interaction.reply('Playing local MP3!');
    } catch (error) {
      console.error('Error playing local file:', error);
      await interaction.reply('Could not play local file. Check console logs.');
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
