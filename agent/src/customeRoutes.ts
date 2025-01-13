import { DirectClient } from "@elizaos/client-direct";
import {
    AgentRuntime,
    elizaLogger,
    IAgentRuntime,
    knowledge,
    stringToUuid,
    Client,
    composeContext,
    generateText,
    ModelClass,
    truncateToCompleteSentence,
    Memory,
    Actor,
    Goal,
    getActorDetails,
    getGoals,
    formatGoalsAsString,
    formatActors,
    formatMessages,
    formatPosts,
    UUID,
    KnowledgeItem,
    addHeader,
    State,
    Action,
    getProviders,
    Evaluator,
    formatActionNames,
    formatActions,
    composeActionExamples,
    formatEvaluators,
    formatEvaluatorNames,
    formatEvaluatorExamples,
    RAGKnowledgeItem,
} from "@elizaos/core";
import { TwitterPostClient } from "../../packages/client-twitter/src/post";
import { names, uniqueNamesGenerator } from "unique-names-generator";
import PostgresDatabaseAdapter from "@elizaos/adapter-postgres";
import pg from "pg";
import { v4 } from "uuid";

export async function createCustomRoutes(
    directClient: DirectClient,
    agents: AgentRuntime[]
) {
    // for now
    const agent = agents[0];

    if (!agent) {
        elizaLogger.error("No agents found");
        return;
    }

    // get requets
    directClient.app.get("/knowledge", async (req, res) => {
        const memories = await agent.knowledgeManager.getMemories({
            roomId: "5832b0fc-9a4b-0fa8-ae51-bb0679a7bc6c",
        });
        res.json({ memories: memories.map((m) => m.content) });
    });

    directClient.app.get("/load-knowledge", async (req, res) => {
        try {
            const text = "Bio Protocol has $400 mil market cap";
            const knowledgeId = stringToUuid(text);
            const existingDocument =
                await agent.documentsManager.getMemoryById(knowledgeId);
            if (existingDocument) {
                res.status(400).json({ error: "Knowledge already exists" });
            }

            elizaLogger.info(
                "Processing knowledge for ",
                agent.character.name,
                " - ",
                text.slice(0, 100)
            );
            console.log({
                id: knowledgeId,
                content: {
                    text: text,
                },
            });
            await knowledge.set(agent, {
                id: knowledgeId,
                content: {
                    text: text,
                },
            });

            res.json({ status: "success" });
        } catch (error) {
            res.status(500).json({ error: error });
            elizaLogger.error("Error loading knowledge:", error);
        }
    });

    directClient.app.get("/generate-tweet", async (req, res) => {
        const twitterPostClient = agent.clients["twitter"]
            .post as TwitterPostClient;
        console.log(`start generating tweet`);
        await twitterPostClient.generateNewTweet();
        res.json({ status: "success" });
    });

    const bootstrapSmokeyRag = async () => {
        elizaLogger.info("Initializing PostgreSQL connection...");
        const pool = new pg.Pool({
            // host: "localhost",
            // user: "postgres",
            // password: "password",
            // database: "postgres",
            connectionString: process.env.POSTGRES_URL,
        });

        // Test the connection
    };

    await bootstrapSmokeyRag();

    // Create a knowledge for tweet rag (to be used in the tweet generation)
    // A topic is searched in tweet knowledge to find a relevant tweets
    const createTweetKnowledge = async (
        pool: pg.Pool,
        knowledge: RAGKnowledgeItem
    ): Promise<void> => {
        const client = await pool.connect();
        try {
            await client.query("BEGIN");

            const metadata = knowledge.content.metadata || {};
            const vectorStr = knowledge.embedding
                ? `[${Array.from(knowledge.embedding).join(",")}]`
                : null;

            // If this is a chunk, use createKnowledgeChunk
            if (metadata.isChunk && metadata.originalId) {
                await createTweetKnowledgeChunk(pool, {
                    id: knowledge.id,
                    originalId: metadata.originalId,
                    agentId: metadata.isShared ? null : knowledge.agentId,
                    content: knowledge.content,
                    embedding: knowledge.embedding,
                    chunkIndex: metadata.chunkIndex || 0,
                    isShared: metadata.isShared || false,
                    createdAt: knowledge.createdAt || Date.now(),
                });
            } else {
                // This is a main knowledge item
                await client.query(
                    `
                            INSERT INTO knowledge (
                                id, "agentId", content, embedding, "createdAt",
                                "isMain", "originalId", "chunkIndex", "isShared"
                            ) VALUES ($1, $2, $3, $4, to_timestamp($5/1000.0), $6, $7, $8, $9)
                            ON CONFLICT (id) DO NOTHING
                        `,
                    [
                        knowledge.id,
                        metadata.isShared ? null : knowledge.agentId,
                        knowledge.content,
                        vectorStr,
                        knowledge.createdAt || Date.now(),
                        true,
                        null,
                        null,
                        metadata.isShared || false,
                    ]
                );
            }

            await client.query("COMMIT");
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    };

    const createTweetKnowledgeChunk = async (
        pool: pg.Pool,
        params: {
            id: UUID;
            originalId: UUID;
            agentId: UUID | null;
            content: any;
            embedding: Float32Array | undefined | null;
            chunkIndex: number;
            isShared: boolean;
            createdAt: number;
        }
    ): Promise<void> => {
        const vectorStr = params.embedding
            ? `[${Array.from(params.embedding).join(",")}]`
            : null;

        // Store the pattern-based ID in the content metadata for compatibility
        const patternId = `${params.originalId}-chunk-${params.chunkIndex}`;
        const contentWithPatternId = {
            ...params.content,
            metadata: {
                ...params.content.metadata,
                patternId,
            },
        };

        await pool.query(
            `
                INSERT INTO knowledge (
                    id, "agentId", content, embedding, "createdAt",
                    "isMain", "originalId", "chunkIndex", "isShared"
                ) VALUES ($1, $2, $3, $4, to_timestamp($5/1000.0), $6, $7, $8, $9)
                ON CONFLICT (id) DO NOTHING
            `,
            [
                v4(), // Generate a proper UUID for PostgreSQL
                params.agentId,
                contentWithPatternId, // Store the pattern ID in metadata
                vectorStr,
                params.createdAt,
                false,
                params.originalId,
                params.chunkIndex,
                params.isShared,
            ]
        );
    };

    let currentTopicIndex = 0;

    directClient.app.get("/tweet", async (req, res) => {
        try {
            const twitterPostClient = agent.clients["twitter"]
                .post as TwitterPostClient;
            console.log(`start generating tweet`);
            // await twitterPostClient.generateNewTweet();
            if (!twitterPostClient?.client) {
                elizaLogger.error("No twitter client found");
                res.status(500).json({ error: "No twitter client found" });
            }
            const twitterClient = twitterPostClient.client;

            if (!twitterClient?.profile?.username) {
                elizaLogger.error("No twitter username found");
                res.status(500).json({ error: "No twitter username found" });
            }

            const roomId = stringToUuid(
                "twitter_generate_room-" + twitterClient.profile.username
            );

            await agent.ensureUserExists(
                agent.agentId,
                twitterClient.profile.username,
                agent.character.name,
                "twitter"
            );

            // const topics = agent.character.topics.join(", ");
            // round-robin through topics
            const selectedTopic = agent.character.topics[currentTopicIndex];
            currentTopicIndex =
                (currentTopicIndex + 1) % agent.character.topics.length;

            if (!selectedTopic?.length) {
                elizaLogger.error("No topics found");
                res.status(500).json({ error: "No topics found" });
            }

            const state = await composeState(
                agent,
                selectedTopic,
                {
                    userId: agent.agentId,
                    roomId: roomId,
                    agentId: agent.agentId,
                    content: {
                        text: selectedTopic,
                        action: "TWEET",
                    },
                },
                {
                    twitterUserName: twitterClient.profile.username,
                }
            );

            if (!agent.character.templates?.twitterPostTemplate) {
                elizaLogger.error("No twitterPostTemplate found in character");
                res.status(500).json({ error: "No twitterPostTemplate found" });
            }

            const context = composeContext({
                state,
                template: agent.character.templates?.twitterPostTemplate || "",
            });

            elizaLogger.debug("generate post prompt:\n" + context);

            const newTweetContent = await generateText({
                runtime: agent,
                context,
                modelClass: ModelClass.SMALL,
            });

            // First attempt to clean content
            let cleanedContent = "";

            // Try parsing as JSON first
            try {
                const parsedResponse = JSON.parse(newTweetContent);
                if (parsedResponse.text) {
                    cleanedContent = parsedResponse.text;
                } else if (typeof parsedResponse === "string") {
                    cleanedContent = parsedResponse;
                }
            } catch (error) {
                error.linted = true; // make linter happy since catch needs a variable
                // If not JSON, clean the raw content
                cleanedContent = newTweetContent
                    .replace(/^\s*{?\s*"text":\s*"|"\s*}?\s*$/g, "") // Remove JSON-like wrapper
                    .replace(/^['"](.*)['"]$/g, "$1") // Remove quotes
                    .replace(/\\"/g, '"') // Unescape quotes
                    .replace(/\\n/g, "\n\n") // Unescape newlines, ensures double spaces
                    .trim();
            }

            if (!cleanedContent) {
                elizaLogger.error(
                    "Failed to extract valid content from response:",
                    {
                        rawResponse: newTweetContent,
                        attempted: "JSON parsing",
                    }
                );
                res.status(500).json({
                    error: "Failed to extract valid content from response",
                });
            }

            // Truncate the content to the maximum tweet length specified in the environment settings, ensuring the truncation respects sentence boundaries.
            const maxTweetLength = twitterClient.twitterConfig.MAX_TWEET_LENGTH;
            if (maxTweetLength) {
                cleanedContent = truncateToCompleteSentence(
                    cleanedContent,
                    maxTweetLength
                );
            }

            const removeQuotes = (str: string) =>
                str.replace(/^['"](.*)['"]$/, "$1");

            const fixNewLines = (str: string) => str.replaceAll(/\\n/g, "\n\n"); //ensures double spaces

            // Final cleaning
            cleanedContent = removeQuotes(fixNewLines(cleanedContent));

            if (true) {
                elizaLogger.info(
                    `Dry run: would have posted tweet: ${cleanedContent}`
                );
                res.json({
                    status: "success",
                    tweet: cleanedContent,
                    topic: selectedTopic,
                    prompt: context,
                });
                return;
            }

            try {
                // if (this.approvalRequired) {
                //     // Send for approval instead of posting directly
                //     elizaLogger.log(
                //         `Sending Tweet For Approval:\n ${cleanedContent}`
                //     );
                //     await this.sendForApproval(
                //         cleanedContent,
                //         roomId,
                //         newTweetContent
                //     );
                //     elizaLogger.log("Tweet sent for approval");
                // } else {
                elizaLogger.log(`Posting new tweet:\n ${cleanedContent}`);
                twitterPostClient.postTweet(
                    agent,
                    twitterClient,
                    cleanedContent,
                    roomId,
                    newTweetContent,
                    twitterPostClient.twitterUsername
                );
                // }
            } catch (error) {
                elizaLogger.error("Error sending tweet:", error);
                res.status(500).json({ error: error });
            }
        } catch (error) {
            elizaLogger.error("Error generating new tweet:", error);
            res.status(500).json({ error: error });
        }
    });

    /**
     * Compose the state of the agent into an object that can be passed or used for response generation.
     * core/runtime.ts has a similar function, it's now refactored to match usecase
     * @param message The message to compose the state from.
     * @returns The state of the agent.
     */
    const composeState = async (
        agentRunTime: AgentRuntime,
        selectedTopic: string,
        message: Memory,
        additionalKeys: { [key: string]: unknown } = {}
    ) => {
        if (!agentRunTime) {
            throw new Error("Agent runtime is required");
        }

        const { userId, roomId } = message;

        const conversationLength = agentRunTime.getConversationLength();

        const [actorsData, recentMessagesData, goalsData]: [
            Actor[],
            Memory[],
            Goal[],
        ] = await Promise.all([
            getActorDetails({ runtime: agentRunTime, roomId }),
            agentRunTime.messageManager.getMemories({
                roomId,
                count: conversationLength,
                unique: false,
            }),
            getGoals({
                runtime: agentRunTime,
                count: 10,
                onlyInProgress: false,
                roomId,
            }),
        ]);

        const goals = formatGoalsAsString({ goals: goalsData });

        const actors = formatActors({ actors: actorsData ?? [] });

        const recentMessages = formatMessages({
            messages: recentMessagesData,
            actors: actorsData,
        });

        const recentPosts = formatPosts({
            messages: recentMessagesData,
            actors: actorsData,
            conversationHeader: false,
        });

        // const lore = formatLore(loreData);

        const senderName = actorsData?.find(
            (actor: Actor) => actor.id === userId
        )?.name;

        // TODO: We may wish to consolidate and just accept character.name here instead of the actor name
        const agentName =
            actorsData?.find(
                (actor: Actor) => actor.id === agentRunTime.agentId
            )?.name || agentRunTime.character.name;

        let allAttachments = message.content.attachments || [];

        if (recentMessagesData && Array.isArray(recentMessagesData)) {
            const lastMessageWithAttachment = recentMessagesData.find(
                (msg) =>
                    msg.content.attachments &&
                    msg.content.attachments.length > 0
            );

            if (lastMessageWithAttachment) {
                const lastMessageTime =
                    lastMessageWithAttachment?.createdAt ?? Date.now();
                const oneHourBeforeLastMessage =
                    lastMessageTime - 60 * 60 * 1000; // 1 hour before last message

                allAttachments = recentMessagesData
                    .reverse()
                    .map((msg) => {
                        const msgTime = msg.createdAt ?? Date.now();
                        const isWithinTime =
                            msgTime >= oneHourBeforeLastMessage;
                        const attachments = msg.content.attachments || [];
                        if (!isWithinTime) {
                            attachments.forEach((attachment) => {
                                attachment.text = "[Hidden]";
                            });
                        }
                        return attachments;
                    })
                    .flat();
            }
        }

        const formattedAttachments = allAttachments
            .map(
                (attachment) =>
                    `ID: ${attachment.id}
    Name: ${attachment.title}
    URL: ${attachment.url}
    Type: ${attachment.source}
    Description: ${attachment.description}
    Text: ${attachment.text}
      `
            )
            .join("\n");

        // randomly get 3 bits of lore and join them into a paragraph, divided by \n
        let lore = "";
        // Assuming agentRunTime.lore is an array of lore bits
        if (
            agentRunTime.character.lore &&
            agentRunTime.character.lore.length > 0
        ) {
            const shuffledLore = [...agentRunTime.character.lore].sort(
                () => Math.random() - 0.5
            );
            const selectedLore = shuffledLore.slice(0, 10);
            lore = selectedLore.join("\n");
        }

        const formattedCharacterPostExamples =
            agentRunTime.character.postExamples
                .sort(() => 0.5 - Math.random())
                .map((post) => {
                    const messageString = `${post}`;
                    return messageString;
                })
                .slice(0, 50)
                .join("\n");

        const formattedCharacterMessageExamples =
            agentRunTime.character.messageExamples
                .sort(() => 0.5 - Math.random())
                .slice(0, 5)
                .map((example) => {
                    const exampleNames = Array.from({ length: 5 }, () =>
                        uniqueNamesGenerator({ dictionaries: [names] })
                    );

                    return example
                        .map((message) => {
                            let messageString = `${message.user}: ${message.content.text}`;
                            exampleNames.forEach((name, index) => {
                                const placeholder = `{{user${index + 1}}}`;
                                messageString = messageString.replaceAll(
                                    placeholder,
                                    name
                                );
                            });
                            return messageString;
                        })
                        .join("\n");
                })
                .join("\n\n");

        const getRecentInteractions = async (
            userA: UUID,
            userB: UUID
        ): Promise<Memory[]> => {
            // Find all rooms where userA and userB are participants
            const rooms =
                await agentRunTime.databaseAdapter.getRoomsForParticipants([
                    userA,
                    userB,
                ]);

            // Check the existing memories in the database
            return agentRunTime.messageManager.getMemoriesByRoomIds({
                // filter out the current room id from rooms
                roomIds: rooms.filter((room) => room !== roomId),
                limit: 20,
            });
        };

        const recentInteractions =
            userId !== agentRunTime.agentId
                ? await getRecentInteractions(userId, agentRunTime.agentId)
                : [];

        const getRecentMessageInteractions = async (
            recentInteractionsData: Memory[]
        ): Promise<string> => {
            // Format the recent messages
            const formattedInteractions = await Promise.all(
                recentInteractionsData.map(async (message) => {
                    const isSelf = message.userId === agentRunTime.agentId;
                    let sender: string;
                    if (isSelf) {
                        sender = agentRunTime.character.name;
                    } else {
                        const accountId =
                            await agentRunTime.databaseAdapter.getAccountById(
                                message.userId
                            );
                        sender = accountId?.username || "unknown";
                    }
                    return `${sender}: ${message.content.text}`;
                })
            );

            return formattedInteractions.join("\n");
        };

        const formattedMessageInteractions =
            await getRecentMessageInteractions(recentInteractions);

        const getRecentPostInteractions = async (
            recentInteractionsData: Memory[],
            actors: Actor[]
        ): Promise<string> => {
            const formattedInteractions = formatPosts({
                messages: recentInteractionsData,
                actors,
                conversationHeader: true,
            });

            return formattedInteractions;
        };

        const formattedPostInteractions = await getRecentPostInteractions(
            recentInteractions,
            actorsData
        );

        // if bio is a string, use it. if its an array, pick one at random
        let bio = agentRunTime.character.bio || "";
        if (Array.isArray(bio)) {
            // get three random bio strings and join them with " "
            bio = bio
                .sort(() => 0.5 - Math.random())
                .slice(0, 3)
                .join(" ");
        }

        let knowledgeData = [];
        let formattedKnowledge = "";

        if (agentRunTime.character.settings?.ragKnowledge) {
            const recentContext = recentMessagesData
                .slice(-3) // Last 3 messages
                .map((msg) => msg.content.text)
                .join(" ");

            knowledgeData = await agentRunTime.ragKnowledgeManager.getKnowledge(
                {
                    query: message.content.text,
                    conversationContext: recentContext,
                    limit: 5,
                }
            );

            formattedKnowledge = formatKnowledge(knowledgeData);
        } else {
            knowledgeData = await knowledge.get(agentRunTime, message);

            formattedKnowledge = formatKnowledge(knowledgeData);
        }

        const initialState = {
            agentId: agentRunTime.agentId,
            agentName,
            bio,
            lore,
            adjective:
                agentRunTime.character.adjectives &&
                agentRunTime.character.adjectives.length > 0
                    ? agentRunTime.character.adjectives[
                          Math.floor(
                              Math.random() *
                                  agentRunTime.character.adjectives.length
                          )
                      ]
                    : "",
            knowledge: formattedKnowledge,
            knowledgeData: knowledgeData,
            ragKnowledgeData: knowledgeData,
            // Recent interactions between the sender and receiver, formatted as messages
            recentMessageInteractions: formattedMessageInteractions,
            // Recent interactions between the sender and receiver, formatted as posts
            recentPostInteractions: formattedPostInteractions,
            // Raw memory[] array of interactions
            recentInteractionsData: recentInteractions,
            // randomly pick one topic
            topic: selectedTopic,
            // agentRunTime.character.topics &&
            // agentRunTime.character.topics.length > 0
            //     ? agentRunTime.character.topics[
            //           Math.floor(
            //               Math.random() *
            //                   agentRunTime.character.topics.length
            //           )
            //       ]
            //     : null,
            topics:
                agentRunTime.character.topics &&
                agentRunTime.character.topics.length > 0
                    ? `${agentRunTime.character.name} is interested in ` +
                      agentRunTime.character.topics
                          .sort(() => 0.5 - Math.random())
                          .slice(0, 5)
                          .map((topic, index) => {
                              if (
                                  index ===
                                  agentRunTime.character.topics.length - 2
                              ) {
                                  return topic + " and ";
                              }
                              // if last topic, don't add a comma
                              if (
                                  index ===
                                  agentRunTime.character.topics.length - 1
                              ) {
                                  return topic;
                              }
                              return topic + ", ";
                          })
                          .join("")
                    : "",
            characterPostExamples:
                formattedCharacterPostExamples &&
                formattedCharacterPostExamples.replaceAll("\n", "").length > 0
                    ? addHeader(
                          `# Example Posts for ${agentRunTime.character.name}`,
                          formattedCharacterPostExamples
                      )
                    : "",
            characterMessageExamples:
                formattedCharacterMessageExamples &&
                formattedCharacterMessageExamples.replaceAll("\n", "").length >
                    0
                    ? addHeader(
                          `# Example Conversations for ${agentRunTime.character.name}`,
                          formattedCharacterMessageExamples
                      )
                    : "",
            messageDirections:
                agentRunTime.character?.style?.all?.length > 0 ||
                agentRunTime.character?.style?.chat.length > 0
                    ? addHeader(
                          "# Message Directions for " +
                              agentRunTime.character.name,
                          (() => {
                              const all =
                                  agentRunTime.character?.style?.all || [];
                              const chat =
                                  agentRunTime.character?.style?.chat || [];
                              return [...all, ...chat].join("\n");
                          })()
                      )
                    : "",

            postDirections:
                agentRunTime.character?.style?.all?.length > 0 ||
                agentRunTime.character?.style?.post.length > 0
                    ? addHeader(
                          "# Post Directions for " +
                              agentRunTime.character.name,
                          (() => {
                              const all =
                                  agentRunTime.character?.style?.all || [];
                              const post =
                                  agentRunTime.character?.style?.post || [];
                              return [...all, ...post].join("\n");
                          })()
                      )
                    : "",

            //old logic left in for reference
            //food for thought. how could we dynamically decide what parts of the character to add to the prompt other than random? rag? prompt the llm to decide?
            /*
                postDirections:
                    agentRunTime.character?.style?.all?.length > 0 ||
                    agentRunTime.character?.style?.post.length > 0
                        ? addHeader(
                                "# Post Directions for " + agentRunTime.character.name,
                                (() => {
                                    const all = agentRunTime.character?.style?.all || [];
                                    const post = agentRunTime.character?.style?.post || [];
                                    const shuffled = [...all, ...post].sort(
                                        () => 0.5 - Math.random()
                                    );
                                    return shuffled
                                        .slice(0, conversationLength / 2)
                                        .join("\n");
                                })()
                            )
                        : "",*/
            // Agent runtime stuff
            senderName,
            actors:
                actors && actors.length > 0
                    ? addHeader("# Actors", actors)
                    : "",
            actorsData,
            roomId,
            goals:
                goals && goals.length > 0
                    ? addHeader(
                          "# Goals\n{{agentName}} should prioritize accomplishing the objectives that are in progress.",
                          goals
                      )
                    : "",
            goalsData,
            recentMessages:
                recentMessages && recentMessages.length > 0
                    ? addHeader("# Conversation Messages", recentMessages)
                    : "",
            recentPosts:
                recentPosts && recentPosts.length > 0
                    ? addHeader("# Posts in Thread", recentPosts)
                    : "",
            recentMessagesData,
            attachments:
                formattedAttachments && formattedAttachments.length > 0
                    ? addHeader("# Attachments", formattedAttachments)
                    : "",
            ...additionalKeys,
        } as State;

        const actionPromises = agentRunTime.actions.map(
            async (action: Action) => {
                const result = await action.validate(
                    agentRunTime,
                    message,
                    initialState
                );
                if (result) {
                    return action;
                }
                return null;
            }
        );

        const evaluatorPromises = agentRunTime.evaluators.map(
            async (evaluator) => {
                const result = await evaluator.validate(
                    agentRunTime,
                    message,
                    initialState
                );
                if (result) {
                    return evaluator;
                }
                return null;
            }
        );

        const [resolvedEvaluators, resolvedActions, providers] =
            await Promise.all([
                Promise.all(evaluatorPromises),
                Promise.all(actionPromises),
                getProviders(agentRunTime, message, initialState),
            ]);

        const evaluatorsData = resolvedEvaluators.filter(
            Boolean
        ) as Evaluator[];
        const actionsData = resolvedActions.filter(Boolean) as Action[];

        const actionState = {
            actionNames:
                "Possible response actions: " + formatActionNames(actionsData),
            actions:
                actionsData.length > 0
                    ? addHeader(
                          "# Available Actions",
                          formatActions(actionsData)
                      )
                    : "",
            actionExamples:
                actionsData.length > 0
                    ? addHeader(
                          "# Action Examples",
                          composeActionExamples(actionsData, 10)
                      )
                    : "",
            evaluatorsData,
            evaluators:
                evaluatorsData.length > 0
                    ? formatEvaluators(evaluatorsData)
                    : "",
            evaluatorNames:
                evaluatorsData.length > 0
                    ? formatEvaluatorNames(evaluatorsData)
                    : "",
            evaluatorExamples:
                evaluatorsData.length > 0
                    ? formatEvaluatorExamples(evaluatorsData)
                    : "",
            providers: addHeader(
                `# Additional Information About ${agentRunTime.character.name} and The World`,
                providers
            ),
        };

        return { ...initialState, ...actionState } as State;
    };
}
const formatKnowledge = (knowledge: KnowledgeItem[]) => {
    return knowledge
        .map((knowledge) => `- ${knowledge.content.text}`)
        .join("\n");
};
