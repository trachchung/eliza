import axios from "axios";
import * as fs from "fs";
import * as csvWriter from "csv-writer";

interface TweetResponse {
    status: string;
    tweet: string;
    topic: string;
    prompt: string;
}

async function fetchTweet(): Promise<TweetResponse> {
    const response = await axios.get("http://localhost:3000/tweet");
    return response.data;
}

async function generateTweets(i: number, filePath: string) {
    const writer = csvWriter.createObjectCsvWriter({
        path: filePath,
        header: [
            { id: "status", title: "STATUS" },
            { id: "tweet", title: "TWEET" },
            { id: "topic", title: "TOPIC" },
            { id: "prompt", title: "PROMPT" },
        ],
    });

    const records: TweetResponse[] = [];

    for (let index = 0; index < i; index++) {
        try {
            const tweet = await fetchTweet();
            records.push(tweet);
        } catch (error) {
            console.error(`Error fetching tweet ${index + 1}:`, error);
        }
    }

    await writer.writeRecords(records);
    console.log(`Successfully saved ${records.length} tweets to ${filePath}`);
}

// Example usage
generateTweets(
    24,
    "/home/charlie/Desktop/eliza/agent/generated-demo-tweets.csv"
);
