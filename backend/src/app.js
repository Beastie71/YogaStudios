const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, PutCommand } = require("@aws-sdk/lib-dynamodb");

// Import the separated scrapers
const { scrapeMomence } = require('./momence');
const { scrapeMindbody } = require('./mindbody');
const { scrapeWellnessLiving } = require('./wellnessliving');

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const CACHE_TABLE = process.env.CACHE_TABLE || 'StudioSyncCache';
//const CACHE_TTL_MS = 60 * 60 * 1000; 
const CACHE_TTL_MS = 60 ; 

module.exports.handler = async (event) => {
    console.log("Received request from Android App!");
    
    const possiblePaths = [
        event.path, 
        event.rawPath, 
        event.resource, 
        event.requestContext?.path, 
        event.requestContext?.resourcePath,
        event.requestContext?.http?.path
    ].join(' ').toLowerCase();

    const headers = event.headers || {};
    
    let targetProvider = 'all';
    if (possiblePaths.includes('/momence')) {
        targetProvider = 'momence';
    } else if (possiblePaths.includes('/mindbody')) {
        targetProvider = 'mindbody';
    } else if (possiblePaths.includes('/wellnessliving')) {
        targetProvider = 'wellnessliving';
    }

    console.log(`Determined Target Provider: ${targetProvider}`);

    // Create a composite userId for cache handling
    const userId = `user_${targetProvider}_${headers['x-momence-user'] || 'none'}_${headers['x-wellness-user'] || 'none'}`;
    
    // Check Cache
    try {
        const response = await docClient.send(new GetCommand({ TableName: CACHE_TABLE, Key: { userId } }));
        if (response.Item && (Date.now() - response.Item.timestamp) < CACHE_TTL_MS) {
            console.log("⚡ Returning cached schedule!");
            let cachedClasses = response.Item.schedule;
            
            if (targetProvider !== 'all') {
                cachedClasses = cachedClasses.filter(c => c.source === targetProvider);
            }
            
            return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(cachedClasses) };
        }
    } catch (e) {}

    let classes = [];
    try {
        if (targetProvider === 'momence') {
            classes = await scrapeMomence(headers['x-momence-user'], headers['x-momence-password']);
        } else if (targetProvider === 'mindbody') {
            classes = await scrapeMindbody();
        } else if (targetProvider === 'wellnessliving') {
            classes = await scrapeWellnessLiving(headers['x-wellness-user'], headers['x-wellness-password']);
        } else {
            // "All" route - Run all three scrapers concurrently!
            const [moClasses, mbClasses, wlClasses] = await Promise.all([
                scrapeMomence(headers['x-momence-user'], headers['x-momence-password']).catch(() => []),
                scrapeMindbodyAnonymous().catch(() => []),
                scrapeWellnessLiving(headers['x-wellness-user'], headers['x-wellness-password']).catch(() => [])
            ]);
            classes = [...moClasses, ...mbClasses, ...wlClasses];
        }

        if (classes.length > 0) {
            await docClient.send(new PutCommand({
                TableName: CACHE_TABLE,
                Item: { userId, schedule: classes, timestamp: Date.now(), ttl: Math.floor(Date.now() / 1000) + 86400 }
            })).catch(() => {});
        }

        if (targetProvider !== 'all') {
            classes = classes.filter(c => c.source === targetProvider);
        }

        return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(classes) };
    } catch (error) {
        console.error("Handler error:", error);
        return { statusCode: 500, body: JSON.stringify({ message: "Scraper Failed: " + error.message }) };
    }
};