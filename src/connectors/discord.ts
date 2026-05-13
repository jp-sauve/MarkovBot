import {
  Client,
  DiscordAPIError,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Message,
  type RESTPostAPIApplicationCommandsJSONBody
} from "discord.js";

import type { Config, DiscordConfig } from "../config/index.js";
import {
  MarkovEngine,
  looksLikeCommand,
  pickSeedWord
} from "../engine/markov.js";

const COMMANDS: RESTPostAPIApplicationCommandsJSONBody[] = [
  new SlashCommandBuilder()
    .setName("markov")
    .setDescription("Generate a Markov response from the shared bot brain.")
    .addStringOption((option) =>
      option
        .setName("prompt")
        .setDescription("Optional seed text to steer the output")
        .setRequired(false)
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("markov-status")
    .setDescription("Show the current Markov bot runtime status.")
    .toJSON()
];

function isIgnoredAuthor(message: Message, config: Config): boolean {
  if (message.author.bot) {
    return true;
  }

  const username = message.author.username.toLowerCase();
  return config.ignoredNicks.some((entry) => entry.toLowerCase() === username);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveMentions(message: Message): string {
  const withUserMentions = message.content.replace(
    /<@!?(\d+)>/g,
    (mention, userId) => {
      const member = message.mentions.members?.get(userId);
      if (member) {
        return `@${member.displayName}`;
      }

      const user = message.mentions.users.get(userId);
      if (user) {
        return `@${user.username}`;
      }

      return mention;
    }
  );

  return withUserMentions.replace(/<#(\d+)>/g, (mention, channelId) => {
    const channel = message.mentions.channels.get(channelId);
    if (channel && "name" in channel && typeof channel.name === "string") {
      return `#${channel.name}`;
    }

    return mention;
  });
}

function shouldRespond(
  message: Message,
  client: Client,
  config: Config
): boolean {
  const botUserId = client.user?.id;
  const mentioned = botUserId ? message.mentions.users.has(botUserId) : false;
  const triggerNames = [
    ...new Set(
      [config.nick, client.user?.username].filter((value): value is string =>
        Boolean(value)
      )
    )
  ];
  const namePattern =
    triggerNames.length > 0
      ? new RegExp(
          `(?:^|\\W)(?:${triggerNames.map((name) => escapeRegExp(name)).join("|")})(?=$|\\W)`,
          "i"
        )
      : null;
  const namedInText = namePattern?.test(message.content) ?? false;

  return mentioned || namedInText || Math.random() < config.replyProbability;
}

async function registerCommands(discordConfig: DiscordConfig): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(discordConfig.token);

  if (discordConfig.guildIds.length > 0) {
    const results = await Promise.allSettled(
      discordConfig.guildIds.map(async (guildId) => {
        await rest.put(
          Routes.applicationGuildCommands(discordConfig.clientId, guildId),
          {
            body: COMMANDS
          }
        );
        return guildId;
      })
    );

    const successfulGuilds = results.filter(
      (result): result is PromiseFulfilledResult<string> =>
        result.status === "fulfilled"
    );
    const failedGuilds = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );

    for (const failure of failedGuilds) {
      const reason = failure.reason;
      if (reason instanceof DiscordAPIError && reason.code === 50001) {
        console.warn(
          `Skipping Discord command registration for an inaccessible guild: ${reason.message}`
        );
      } else {
        console.warn(
          "Discord command registration failed for a guild:",
          reason
        );
      }
    }

    if (successfulGuilds.length > 0) {
      console.log(
        `Registered Discord slash commands in ${successfulGuilds.length} guild(s).`
      );
    }

    return;
  }

  try {
    await rest.put(Routes.applicationCommands(discordConfig.clientId), {
      body: COMMANDS
    });
    console.log("Registered global Discord slash commands.");
  } catch (error) {
    console.warn(
      "Global Discord command registration failed; continuing without slash commands.",
      error
    );
  }
}

async function handleSlashCommand(
  interaction: ChatInputCommandInteraction,
  config: Config,
  markov: MarkovEngine
): Promise<void> {
  if (interaction.commandName === "markov-status") {
    const discordState = config.discord
      ? `enabled in ${config.discord.channels.length} channel(s)`
      : "disabled";
    await interaction.reply({
      content: `MarkovBot is online. IRC channels: ${config.channels.length}. Discord: ${discordState}.`,
      ephemeral: true
    });
    return;
  }

  if (interaction.commandName === "markov") {
    const prompt = interaction.options.getString("prompt") ?? undefined;
    const response = markov.generateAndLog(prompt, {
      source: "discord",
      channel: interaction.channelId
    });
    await interaction.reply(
      response || "I do not have enough training data yet."
    );
  }
}

export async function startDiscordBot(
  config: Config,
  markov: MarkovEngine
): Promise<{ stop: () => Promise<void> }> {
  if (!config.discord) {
    throw new Error("Discord is not configured.");
  }

  await registerCommands(config.discord);

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent
    ]
  });

  client.once("ready", () => {
    console.log(
      `Connected to Discord as ${client.user?.tag ?? "unknown user"}`
    );
  });

  client.on("messageCreate", async (message) => {
    const discordConfig = config.discord;
    if (!discordConfig || !discordConfig.channels.includes(message.channelId)) {
      return;
    }

    if (isIgnoredAuthor(message, config)) {
      return;
    }

    if (looksLikeCommand(message.content)) {
      return;
    }

    const resolvedContent = resolveMentions(message);

    markov.learn(resolvedContent);

    if (!shouldRespond(message, client, config)) {
      return;
    }

    const response = markov.generateAndLog(
      pickSeedWord(resolvedContent, client.user?.username ?? config.nick),
      {
        source: "discord",
        channel: message.channelId
      }
    );
    if (!response) {
      return;
    }

    if (message.channel?.isTextBased()) {
      await message.channel.send(response);
    }
  });

  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    try {
      await handleSlashCommand(interaction, config, markov);
    } catch (error) {
      console.error("Discord command failed:", error);
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({
          content: "Command failed.",
          ephemeral: true
        });
      } else {
        await interaction.reply({
          content: "Command failed.",
          ephemeral: true
        });
      }
    }
  });

  await client.login(config.discord.token);

  return {
    stop: async () => {
      client.destroy();
    }
  };
}
