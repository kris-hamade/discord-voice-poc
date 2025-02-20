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
// Store loop information per guild (guildId -> loop URL)
const loops = new Map();

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
    name: 'loop',
    description: 'Loop a YouTube link continuously until stopped.',
    options: [
      {
        name: 'url',
        type: 3, // STRING
        description: 'The YouTube URL to loop.',
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
// Helper: Setup Idle Listener for a given player & connection
// ----------------------------------------------------------------------
function setupIdleListener(player, connection) {
  // Remove any existing idle listeners to override old behavior
  player.removeAllListeners(AudioPlayerStatus.Idle);
  player.on(AudioPlayerStatus.Idle, () => {
    const guildId = connection.joinConfig.guildId;
    if (loops.has(guildId)) {
      const loopUrl = loops.get(guildId);
      console.log(`Looping track: ${loopUrl}`);
      try {
        const stream = ytdl(loopUrl, { filter: 'audioonly' });
        const resource = createAudioResource(stream);
        player.play(resource);
      } catch (err) {
        console.error('Error replaying loop track:', err);
        // In case of error, clear loop and start idle disconnect
        loops.delete(guildId);
        startIdleTimer(connection, guildId);
      }
    } else {
      console.log('AudioPlayerStatus: Idle (no loop set)');
      startIdleTimer(connection, guildId);
    }
  });
}

// ----------------------------------------------------------------------
// Main command handling
// ----------------------------------------------------------------------
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const guildId = interaction.guildId;

  // --------------------------- PLAY COMMAND ---------------------------
  if (interaction.commandName === 'play') {
    const url = interaction.options.getString('url');
    console.log('Received play command with URL:', url);

    // Clear any existing loop if playing a new track
    loops.delete(guildId);

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
    let connection = getVoiceConnection(guildId);
    if (!connection) {
      connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: guildId,
        adapterCreator: interaction.guild.voiceAdapterCreator,
        selfDeaf: false,
      });
    }

    try {
      const stream = ytdl(url, { filter: 'audioonly' });
      const resource = createAudioResource(stream);

      let player = connection.state.subscription?.player;
      if (!player) {
        player = createAudioPlayer();
        connection.subscribe(player);

        player.on(AudioPlayerStatus.Playing, () => {
          console.log('AudioPlayerStatus: Playing');
          clearIdleTimer(guildId);
        });
        setupIdleListener(player, connection);
        player.on(AudioPlayerStatus.Buffering, () => {
          console.log('AudioPlayerStatus: Buffering');
        });
        player.on(AudioPlayerStatus.Paused, () => {
          console.log('AudioPlayerStatus: Paused');
        });
        player.on('error', (err) => {
          console.error('Audio player error:', err);
        });
      } else {
        // Update idle listener in case it was previously set for looping
        setupIdleListener(player, connection);
      }

      player.play(resource);

      await interaction.reply(`Now playing: ${url}`);
    } catch (error) {
      console.error('Error playing YouTube audio:', error);
      await interaction.reply('Failed to play the audio. Please try again.');
    }
  }

  // --------------------------- LOOP COMMAND ---------------------------
  if (interaction.commandName === 'loop') {
    const url = interaction.options.getString('url');
    console.log('Received loop command with URL:', url);

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

    // Join voice channel if not connected
    let connection = getVoiceConnection(guildId);
    if (!connection) {
      connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: guildId,
        adapterCreator: interaction.guild.voiceAdapterCreator,
        selfDeaf: false,
      });
    }

    // Clear any idle timer
    clearIdleTimer(guildId);

    try {
      let player = connection.state.subscription?.player;
      if (!player) {
        player = createAudioPlayer();
        connection.subscribe(player);

        player.on(AudioPlayerStatus.Playing, () => {
          console.log('AudioPlayerStatus: Playing');
          clearIdleTimer(guildId);
        });
        setupIdleListener(player, connection);
        player.on(AudioPlayerStatus.Buffering, () => {
          console.log('AudioPlayerStatus: Buffering');
        });
        player.on(AudioPlayerStatus.Paused, () => {
          console.log('AudioPlayerStatus: Paused');
        });
        player.on('error', (err) => {
          console.error('Audio player error:', err);
        });
      } else {
        // Update idle listener to ensure loop behavior is in place
        setupIdleListener(player, connection);
      }

      // Set the loop flag for this guild
      loops.set(guildId, url);

      const stream = ytdl(url, { filter: 'audioonly' });
      const resource = createAudioResource(stream);
      player.play(resource);

      await interaction.reply(`Now looping: ${url}`);
    } catch (error) {
      console.error('Error looping track:', error);
      await interaction.reply('Failed to loop the track. Please try again.');
    }
  }

  // --------------------------- STOP COMMAND ---------------------------
  if (interaction.commandName === 'stop') {
    const connection = getVoiceConnection(guildId);

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
      // Clear loop flag if set
      loops.delete(guildId);
      player.stop(true); // Force stop
      await interaction.reply('Playback has been **stopped**.');
      // Bot remains in voice; now it's idle, so we start the idle timer
      startIdleTimer(connection, guildId);
    } catch (error) {
      console.error('Error stopping playback:', error);
      await interaction.reply('Failed to stop playback. Check console logs.');
    }
  }

  // --------------------------- DISCONNECT COMMAND ---------------------------
  if (interaction.commandName === 'disconnect') {
    const connection = getVoiceConnection(guildId);

    if (!connection) {
      return interaction.reply({
        content: 'The bot is not connected to a voice channel.',
        ephemeral: true,
      });
    }

    try {
      clearIdleTimer(guildId);
      loops.delete(guildId);
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

    let connection = getVoiceConnection(guildId);
    if (!connection) {
      connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: guildId,
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
          clearIdleTimer(guildId);
        });
        setupIdleListener(player, connection);
        player.on(AudioPlayerStatus.Buffering, () => {
          console.log('AudioPlayerStatus: Buffering (local file)');
        });
        player.on(AudioPlayerStatus.Paused, () => {
          console.log('AudioPlayerStatus: Paused (local file)');
        });
        player.on('error', (err) => {
          console.error('Audio player error (local file):', err);
        });
      } else {
        setupIdleListener(player, connection);
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