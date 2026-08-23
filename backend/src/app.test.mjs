import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handler } from './app.mjs';

describe('ScheduleProxyFunction', () => {
    it('should return a 200 success response with mock classes', async () => {
        const event = {}; // Mock empty API Gateway event
        const response = await handler(event);

        assert.strictEqual(response.statusCode, 200);
        
        const body = JSON.parse(response.body);
        assert.ok(Array.isArray(body), 'Body should be an array');
        assert.strictEqual(body.length, 3, 'Should return 3 mock classes');
        assert.strictEqual(body[0].studioName, 'Mindbody (BFF)');
    });
});
