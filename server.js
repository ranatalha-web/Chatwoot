import express from 'express';
import fetch from 'node-fetch';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = 3000;

// Middleware
app.use(express.json());
app.use(express.static('public'));
app.use(cors());

// Hostway Configuration
const conversationsUrl = 'https://api.hostaway.com/v1/conversations';
const hostwayHeaders = {
    'Authorization': 'Bearer eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJhdWQiOiI4MDA2NiIsImp0aSI6ImM5MDQ4NTgzNTBhYWNiOTdiMzBkNDAxMjczMDBjYTkyZmE1Njg0ZTU0MzJiMjMyNWM2YTIzYmVkMTQ5ZGE4YTQyNjUwMzgwMWY0YmI0YmNlIiwiaWF0IjoxNzM3OTc5NDcwLjk3NzYxMiwibmJmIjoxNzM3OTc5NDcwLjk3NzYxNCwiZXhwIjoyMDUzNTEyMjcwLjk3NzYxOCwic3ViIjoiIiwic2NvcGVzIjpbImdlbmVyYWwiXSwic2VjcmV0SWQiOjUzMDQzfQ.ItaGLJwySFtroyXsLdS_zMIeEDPivN-MjjHPxOvCjoHvFqAHuX4HBX-HCjAp-5f2gKLilxPsRcdYRkDvViILKr73qyo6nSnNPokYj3JUYXsuBLoKMejzwuvYMn_DQc2HbbdDAmV_iREKMfiPyJu2vJjRSKI5xc033CGFm5Tng-c',
    'Content-Type': 'application/json',
};

// Chatwoot Configuration
const CHATWOOT_BASE_URL = process.env.CHATWOOT_BASE_URL || 'http://100.27.236.133:3000';
const CHATWOOT_API_TOKEN = process.env.CHATWOOT_API_TOKEN || 'DbrXAQ2RLXqzUQPgEtgMgFur';
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID || '1';
const CHATWOOT_INBOX_ID = process.env.CHATWOOT_INBOX_ID || '4';

// In-memory storage
let processedMessages = new Set();
let contactsMap = new Map();
let conversationMappings = new Map();

// Helper function to check if message is from today
const isMessageFromToday = (date) => {
    const messageDate = new Date(date);
    const today = new Date();
    return messageDate.getDate() === today.getDate() &&
           messageDate.getMonth() === today.getMonth() &&
           messageDate.getFullYear() === today.getFullYear();
};

// Create or get Chatwoot contact
async function createOrGetChatwootContact(recipientName) {
    try {
        if (contactsMap.has(recipientName)) {
            return contactsMap.get(recipientName);
        }

        const searchResponse = await fetch(
            `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/contacts/search?q=${encodeURIComponent(recipientName)}`,
            {
                headers: {
                    'api_access_token': CHATWOOT_API_TOKEN,
                    'Content-Type': 'application/json'
                }
            }
        );

        if (searchResponse.ok) {
            const searchData = await searchResponse.json();
            if (searchData.payload && searchData.payload.length > 0) {
                const contactId = searchData.payload[0].id;
                contactsMap.set(recipientName, contactId);
                return contactId;
            }
        }

        const createResponse = await fetch(
            `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/contacts`,
            {
                method: 'POST',
                headers: {
                    'api_access_token': CHATWOOT_API_TOKEN,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    inbox_id: CHATWOOT_INBOX_ID,
                    name: recipientName,
                    identifier: recipientName.replace(/\s+/g, '_').toLowerCase()
                })
            }
        );

        if (createResponse.ok) {
            const contactData = await createResponse.json();
            contactsMap.set(recipientName, contactData.id);
            return contactData.id;
        }

        throw new Error('Failed to create contact');
    } catch (error) {
        console.error('Error in createOrGetChatwootContact:', error);
        throw error;
    }
}

// Create Chatwoot conversation
async function createChatwootConversation(contactId, recipientName) {
    try {
        const response = await fetch(
            `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations`,
            {
                method: 'POST',
                headers: {
                    'api_access_token': CHATWOOT_API_TOKEN,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    inbox_id: CHATWOOT_INBOX_ID,
                    contact_id: contactId,
                    custom_attributes: { recipient_name: recipientName }
                })
            }
        );

        if (!response.ok) {
            throw new Error('Failed to create Chatwoot conversation');
        }

        const data = await response.json();
        return data.id;
    } catch (error) {
        console.error('Error in createChatwootConversation:', error);
        throw error;
    }
}

// Send message to Chatwoot
async function sendToChatwoot(conversationId, message, isIncoming = true) {
    try {
        const response = await fetch(
            `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`,
            {
                method: 'POST',
                headers: {
                    'api_access_token': CHATWOOT_API_TOKEN,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    content: message,
                    message_type: isIncoming ? 'incoming' : 'outgoing'
                })
            }
        );

        if (!response.ok) {
            throw new Error('Failed to send message to Chatwoot');
        }

        return await response.json();
    } catch (error) {
        console.error('Error in sendToChatwoot:', error);
        throw error;
    }
}

// Send message to Hostway
async function sendToHostway(conversationId, message) {
    try {
        const response = await fetch(
            `https://api.hostaway.com/v1/conversations/${conversationId}/messages`,
            {
                method: 'POST',
                headers: hostwayHeaders,
                body: JSON.stringify({ body: message })
            }
        );

        if (!response.ok) {
            throw new Error('Failed to send message to Hostway');
        }

        return await response.json();
    } catch (error) {
        console.error('Error in sendToHostway:', error);
        throw error;
    }
}

// Route to handle message fetching
app.get('/messages', async (req, res) => {
    try {
        const response = await fetch(conversationsUrl, { headers: hostwayHeaders });
        if (!response.ok) throw new Error('Failed to fetch conversations');

        const data = await response.json();
        const todaysMessages = [];

        for (const conversation of data.result.slice(0, 400)) {
            const messageResponse = await fetch(
                `https://api.hostaway.com/v1/conversations/${conversation.id}/messages`,
                { headers: hostwayHeaders }
            );

            if (!messageResponse.ok) continue;

            const messageData = await messageResponse.json();
            const recipientName = conversation.recipientName || 'Unknown Guest';

            for (const message of messageData.result) {
                if (message.isIncoming === 1 && isMessageFromToday(message.date) && !processedMessages.has(message.id)) {
                    try {
                        // Create or get Chatwoot contact and conversation
                        const contactId = await createOrGetChatwootContact(recipientName);
                        let chatwootConversationId = conversationMappings.get(conversation.id);

                        if (!chatwootConversationId) {
                            chatwootConversationId = await createChatwootConversation(contactId, recipientName);
                            conversationMappings.set(conversation.id, chatwootConversationId);
                        }

                        // Send message to Chatwoot
                        await sendToChatwoot(chatwootConversationId, message.body);

                        // Add to processed messages
                        processedMessages.add(message.id);

                        // Add to today's messages
                        todaysMessages.push({
                            id: message.id,
                            conversation_id: conversation.id,
                            chatwoot_conversation_id: chatwootConversationId,
                            exactDate: message.date,
                            recipientName: recipientName,
                            body: message.body
                        });

                        console.log(`Message processed and sent to Chatwoot: ${message.id}`);
                    } catch (error) {
                        console.error(`Error processing message ${message.id}:`, error);
                    }
                }
            }
        }

        res.json({
            success: true,
            message: "Messages processed successfully",
            todaysMessages: todaysMessages
        });
    } catch (error) {
        console.error('Error in /messages route:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Route to handle replies
app.post('/reply', async (req, res) => {
    try {
        const { hostwayConversationId, chatwootConversationId, message } = req.body;

        if (!hostwayConversationId || !message) {
            return res.status(400).json({ success: false, error: 'Missing required parameters' });
        }

        // Send to Hostway
        await sendToHostway(hostwayConversationId, message);

        // Send to Chatwoot if conversation exists
        if (chatwootConversationId) {
            await sendToChatwoot(chatwootConversationId, message, false);
        }

        res.json({
            success: true,
            message: 'Reply sent successfully to both platforms'
        });
    } catch (error) {
        console.error('Error in /reply route:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}/`);
});