import express from 'express';
import fetch from 'node-fetch';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', true);
app.use(express.json());
app.use(express.static('public'));
app.use(cors());

const conversationsUrl = 'https://api.hostaway.com/v1/conversations';
const hostawayHeaders = {
    'Authorization': 'Bearer eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJhdWQiOiI4MDA2NiIsImp0aSI6ImM5MDQ4NTgzNTBhYWNiOTdiMzBkNDAxMjczMDBjYTkyZmE1Njg0ZTU0MzJiMjMyNWM2YTIzYmVkMTQ5ZGE4YTQyNjUwMzgwMWY0YmI0YmNlIiwiaWF0IjoxNzM3OTc5NDcwLjk3NzYxMiwibmJmIjoxNzM3OTc5NDcwLjk3NzYxNCwiZXhwIjoyMDUzNTEyMjcwLjk3NzYxOCwic3ViIjoiIiwic2NvcGVzIjpbImdlbmVyYWwiXSwic2VjcmV0SWQiOjUzMDQzfQ.ItaGLJwySFtroyXsLdS_zMIeEDPivN-MjjHPxOvCjoHvFqAHuX4HBX-HCjAp-5f2gKLilxPsRcdYRkDvViILKr73qyo6nSnNPokYj3JUYXsuBLoKMejzwuvYMn_DQc2HbbdDAmV_iREKMfiPyJu2vJjRSKI5xc033CGFm5Tng-c',
    'Content-Type': 'application/json',
};

const CHATWOOT_BASE_URL = process.env.CHATWOOT_BASE_URL || 'http://100.27.236.133:3000';
const CHATWOOT_API_TOKEN = process.env.CHATWOOT_API_TOKEN || 'DbrXAQ2RLXqzUQPgEtgMgFur';
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID || '1';
const CHATWOOT_INBOX_ID = process.env.CHATWOOT_INBOX_ID || '5';

// In-memory caches
let processedMessages = new Set();
let contactsMap = new Map();
let conversationMappings = new Map();
let lastCheckedChatwootTime = new Date();
let processedChatwootMessages = new Set();
let hostawayConversationsCache = null; // Cache for Hostaway conversations

const isMessageFromToday = (date) => {
    const messageDate = new Date(date);
    const today = new Date();
    return messageDate.getDate() === today.getDate() &&
           messageDate.getMonth() === today.getMonth() &&
           messageDate.getFullYear() === today.getFullYear();
};

async function createOrGetChatwootContact(recipientName) {
    if (contactsMap.has(recipientName)) return contactsMap.get(recipientName);

    const searchResponse = await fetch(
        `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/contacts/search?q=${encodeURIComponent(recipientName)}`,
        { headers: { 'api_access_token': CHATWOOT_API_TOKEN, 'Content-Type': 'application/json' } }
    );
    if (searchResponse.ok) {
        const searchData = await searchResponse.json();
        if (searchData.payload?.length > 0) {
            const contactId = searchData.payload[0].id;
            contactsMap.set(recipientName, contactId);
            return contactId;
        }
    }

    const createResponse = await fetch(
        `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/contacts`,
        {
            method: 'POST',
            headers: { 'api_access_token': CHATWOOT_API_TOKEN, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                inbox_id: CHATWOOT_INBOX_ID,
                name: recipientName,
                identifier: recipientName.replace(/\s+/g, '_').toLowerCase()
            })
        }
    );
    if (!createResponse.ok) throw new Error('Failed to create contact');
    const contactData = await createResponse.json();
    contactsMap.set(recipientName, contactData.id);
    return contactData.id;
}

async function createChatwootConversation(contactId, recipientName) {
    const response = await fetch(
        `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations`,
        {
            method: 'POST',
            headers: { 'api_access_token': CHATWOOT_API_TOKEN, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                inbox_id: CHATWOOT_INBOX_ID,
                contact_id: contactId,
                custom_attributes: { recipient_name: recipientName }
            })
        }
    );
    if (!response.ok) throw new Error('Failed to create Chatwoot conversation');
    const data = await response.json();
    return data.id;
}

async function sendToChatwoot(conversationId, message, isIncoming = true) {
    const response = await fetch(
        `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`,
        {
            method: 'POST',
            headers: { 'api_access_token': CHATWOOT_API_TOKEN, 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: message, message_type: isIncoming ? 'incoming' : 'outgoing' })
        }
    );
    if (!response.ok) throw new Error('Failed to send message to Chatwoot');
    return await response.json();
}

async function sendToHostaway(conversationId, message) {
    console.log(`Sending to Hostaway ${conversationId}: "${message}"`); // Minimal logging
    const response = await fetch(
        `https://api.hostaway.com/v1/conversations/${conversationId}/messages`,
        { method: 'POST', headers: hostawayHeaders, body: JSON.stringify({ body: message }) }
    );
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Hostaway API error: ${errorText}`);
    }
    return await response.json();
}

async function getChatwootMessages(conversationId) {
    const response = await fetch(
        `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`,
        { headers: { 'api_access_token': CHATWOOT_API_TOKEN } }
    );
    if (!response.ok) throw new Error('Failed to fetch Chatwoot messages');
    const data = await response.json();
    return data.payload || [];
}

async function syncChatwootOutgoingMessages() {
    console.log('Starting Chatwoot to Hostaway sync');
    const mappings = Array.from(conversationMappings.entries());
    await Promise.all(mappings.map(async ([hostawayId, chatwootId]) => {
        try {
            const messages = await getChatwootMessages(chatwootId);
            const outgoingMessages = messages.filter(msg => msg.message_type === 'outgoing' && !processedChatwootMessages.has(msg.id) && msg.content);
            for (const message of outgoingMessages) {
                await sendToHostaway(hostawayId, message.content);
                processedChatwootMessages.add(message.id);
            }
        } catch (error) {
            console.error(`Error syncing Hostaway ${hostawayId} <-> Chatwoot ${chatwootId}:`, error.message);
        }
    }));
    console.log('Completed Chatwoot to Hostaway sync');
}

app.get('/messages', async (req, res) => {
    try {
        console.log('Starting Hostaway to Chatwoot sync');
        const response = await fetch(conversationsUrl, { headers: hostawayHeaders });
        if (!response.ok) throw new Error('Failed to fetch Hostaway conversations');
        const data = await response.json();
        hostawayConversationsCache = data.result; // Cache Hostaway conversations
        const todaysMessages = [];

        for (const conversation of data.result) {
            const messageResponse = await fetch(
                `https://api.hostaway.com/v1/conversations/${conversation.id}/messages`,
                { headers: hostawayHeaders }
            );
            if (!messageResponse.ok) continue;
            const messageData = await messageResponse.json();
            const recipientName = conversation.recipientName || 'Unknown Guest';
            const todaysMessagesInConversation = messageData.result.filter(isMessageFromToday);

            for (const message of todaysMessagesInConversation) {
                if (message.isIncoming !== 1 || processedMessages.has(message.id)) continue;
                const contactId = await createOrGetChatwootContact(recipientName);
                let chatwootConversationId = conversationMappings.get(conversation.id);
                if (!chatwootConversationId) {
                    chatwootConversationId = await createChatwootConversation(contactId, recipientName);
                    conversationMappings.set(conversation.id, chatwootConversationId);
                }
                await sendToChatwoot(chatwootConversationId, message.body);
                processedMessages.add(message.id);
                todaysMessages.push({
                    id: message.id,
                    conversation_id: conversation.id,
                    chatwoot_conversation_id: chatwootConversationId,
                    recipientName,
                    date: message.date,
                    body: message.body,
                    isIncoming: message.isIncoming === 1
                });
            }
        }

        todaysMessages.sort((a, b) => new Date(b.date) - new Date(a.date));
        await syncChatwootOutgoingMessages();
        res.json({ success: true, message: "Today's messages retrieved successfully", todaysMessages });
    } catch (error) {
        console.error('Error in /messages:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/webhooks/chatwoot', async (req, res) => {
    try {
        console.log('Webhook triggered:', req.body.conversation?.id, req.body.content); // Minimal logging
        const { event, conversation, message_type, content } = req.body;
        if (event !== 'message_created' || message_type !== 'outgoing' || !conversation?.id || !content) {
            return res.status(400).json({ success: false, error: 'Invalid webhook data' });
        }

        let hostawayConversationId = conversationMappings.get(conversation.id);
        if (!hostawayConversationId && hostawayConversationsCache) {
            const recipientName = conversation.custom_attributes?.recipient_name || conversation.meta?.contact?.name || 'Unknown Guest';
            const matchingConversation = hostawayConversationsCache.find(conv => conv.recipientName === recipientName);
            if (matchingConversation) {
                hostawayConversationId = matchingConversation.id;
                conversationMappings.set(hostawayConversationId, conversation.id);
            } else {
                return res.status(404).json({ success: false, error: 'No matching Hostaway conversation found' });
            }
        }

        if (!hostawayConversationId) return res.status(404).json({ success: false, error: 'No matching Hostaway conversation found' });

        const hostawayResponse = await sendToHostaway(hostawayConversationId, content);
        res.json({ success: true, message: 'Message sent to Hostaway successfully', hostawayMessageId: hostawayResponse.id });
    } catch (error) {
        console.error('Webhook error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/send-message', async (req, res) => {
    try {
        const { conversationId, message } = req.body;
        if (!conversationId || !message) return res.status(400).json({ success: false, error: 'Conversation ID and message are required' });

        const chatwootConvId = parseInt(conversationId);
        let hostawayConversationId = conversationMappings.get(chatwootConvId);

        if (!hostawayConversationId && hostawayConversationsCache) {
            const chatwootConvResponse = await fetch(
                `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${chatwootConvId}`,
                { headers: { 'api_access_token': CHATWOOT_API_TOKEN } }
            );
            if (!chatwootConvResponse.ok) throw new Error('Failed to fetch Chatwoot conversation');
            const chatwootConvData = await chatwootConvResponse.json();
            const recipientName = chatwootConvData.custom_attributes?.recipient_name || chatwootConvData.meta?.contact?.name || 'Unknown Guest';
            const matchingConversation = hostawayConversationsCache.find(conv => conv.recipientName === recipientName);
            if (!matchingConversation) return res.status(400).json({ success: false, error: `No Hostaway conversation for '${recipientName}'` });
            hostawayConversationId = matchingConversation.id;
            conversationMappings.set(hostawayConversationId, chatwootConvId);
        }

        if (!hostawayConversationId) return res.status(400).json({ success: false, error: 'No matching Hostaway conversation found' });

        const hostawayResponse = await sendToHostaway(hostawayConversationId, message);
        const chatwootResponse = await sendToChatwoot(chatwootConvId, message, false);
        processedChatwootMessages.add(chatwootResponse.id);
        res.json({
            success: true,
            message: 'Message sent successfully to both systems',
            hostawayMessageId: hostawayResponse.id,
            chatwootMessageId: chatwootResponse.id
        });
    } catch (error) {
        console.error('Error in send-message:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/chatwoot/conversations', async (req, res) => {
    try {
        const response = await fetch(
            `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations`,
            { headers: { 'api_access_token': CHATWOOT_API_TOKEN } }
        );
        if (!response.ok) throw new Error('Failed to fetch Chatwoot conversations');
        const data = await response.json();
        res.json({ success: true, conversations: data });
    } catch (error) {
        console.error('Error fetching Chatwoot conversations:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/sync-chatwoot-to-hostaway', async (req, res) => {
    try {
        await syncChatwootOutgoingMessages();
        res.json({ success: true, message: 'Manually triggered sync completed' });
    } catch (error) {
        console.error('Error in manual sync:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/debug/mappings', async (req, res) => {
    try {
        const mappings = Array.from(conversationMappings.entries()).map(([hostawayId, chatwootId]) => ({
            hostawayId,
            chatwootId
        }));
        res.json({ success: true, mappingCount: mappings.length, mappings });
    } catch (error) {
        console.error('Error in debug mappings:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/debug/sync-status', async (req, res) => {
    try {
        const processedHostawayMessagesArray = Array.from(processedMessages).slice(0, 20);
        const processedChatwootMessagesArray = Array.from(processedChatwootMessages).slice(0, 20);
        res.json({
            success: true,
            timestamp: new Date().toISOString(),
            status: {
                mappings: {
                    count: conversationMappings.size,
                    data: Array.from(conversationMappings.entries()).map(([hId, cId]) => ({ hostawayId: hId, chatwootId: cId }))
                },
                processedMessages: {
                    hostaway: { count: processedMessages.size, sample: processedHostawayMessagesArray },
                    chatwoot: { count: processedChatwootMessages.size, sample: processedChatwootMessagesArray }
                },
                lastCheckedTime: lastCheckedChatwootTime.toISOString()
            }
        });
    } catch (error) {
        console.error('Error in debug sync status:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    setInterval(async () => {
        try {
            const startTime = new Date();
            const response = await fetch(`http://localhost:${PORT}/messages`);
            if (!response.ok) console.error(`Scheduled sync failed: ${response.status}`);
            const duration = (new Date() - startTime) / 1000;
            console.log(`Scheduled sync completed in ${duration.toFixed(2)}s`);
        } catch (error) {
            console.error('Scheduled sync error:', error.message);
        }
    }, 30000); // Consider reducing to 15000 if needed
});