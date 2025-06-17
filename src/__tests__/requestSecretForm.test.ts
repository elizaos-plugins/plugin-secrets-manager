import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requestSecretFormAction } from '../actions/requestSecretForm';
import type { IAgentRuntime, Memory, HandlerCallback } from '@elizaos/core';
import { SecretFormService } from '../services/secret-form-service';

// Mock dependencies
vi.mock('@elizaos/core', async () => {
  const actual = await vi.importActual('@elizaos/core');
  return {
    ...actual,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    elizaLogger: {
      info: vi.fn(),
      error: vi.fn(),
    },
    parseJSONObjectFromText: vi.fn(),
  };
});

describe('requestSecretFormAction', () => {
  let mockRuntime: IAgentRuntime;
  let mockFormService: SecretFormService;
  let mockCallback: HandlerCallback;

  beforeEach(() => {
    vi.clearAllMocks();

    // Create mock form service
    mockFormService = {
      createSecretForm: vi.fn().mockResolvedValue({
        url: 'https://test.ngrok.io/form/123',
        sessionId: 'session-123',
      }),
    } as any;

    // Create mock runtime
    mockRuntime = {
      agentId: 'agent-123',
      getService: vi.fn((type: string) => {
        if (type === 'SECRET_FORMS') return mockFormService;
        return null;
      }),
    } as any;

    // Create mock callback
    mockCallback = vi.fn();
  });

  describe('validate', () => {
    it('should return true when service exists and keywords match', async () => {
      const message: Memory = {
        content: { text: 'I need you to request secret from me' },
        entityId: 'user-123',
      } as any;

      const result = await requestSecretFormAction.validate(mockRuntime, message);
      expect(result).toBe(true);
    });

    it('should return false when service does not exist', async () => {
      mockRuntime.getService = vi.fn(() => null);

      const message: Memory = {
        content: { text: 'request secret' },
        entityId: 'user-123',
      } as any;

      const result = await requestSecretFormAction.validate(mockRuntime, message);
      expect(result).toBe(false);
    });

    it('should match various keywords', async () => {
      const testCases = [
        'request secret from user',
        'need information about api',
        'collect secret data',
        'create form for credentials',
        'ask for api key',
        'request credentials',
      ];

      for (const text of testCases) {
        const message: Memory = {
          content: { text },
          entityId: 'user-123',
        } as any;

        const result = await requestSecretFormAction.validate(mockRuntime, message);
        expect(result).toBe(true);
      }
    });

    it('should return false for non-matching text', async () => {
      const message: Memory = {
        content: { text: 'hello world' },
        entityId: 'user-123',
      } as any;

      const result = await requestSecretFormAction.validate(mockRuntime, message);
      expect(result).toBe(false);
    });
  });

  describe('handler', () => {
    it('should create form for API key request', async () => {
      const message: Memory = {
        content: { text: 'Request my OpenAI API key' },
        entityId: 'user-123',
      } as any;

      const result = await requestSecretFormAction.handler(
        mockRuntime,
        message,
        {},
        {},
        mockCallback
      );

      expect(result).toBe(true);
      expect(mockFormService.createSecretForm).toHaveBeenCalledWith(
        expect.objectContaining({
          secrets: expect.arrayContaining([
            expect.objectContaining({
              key: 'OPENAI_API_KEY',
              config: expect.objectContaining({
                type: 'api_key',
                description: 'OpenAI API Key',
              }),
            }),
          ]),
        }),
        expect.objectContaining({
          level: 'user',
          userId: 'user-123',
          agentId: 'agent-123',
        }),
        expect.any(Function)
      );

      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('https://test.ngrok.io/form/123'),
        data: {
          formUrl: 'https://test.ngrok.io/form/123',
          sessionId: 'session-123',
          expiresAt: expect.any(Number),
        },
      });
    });

    it('should handle multiple API keys', async () => {
      // Ensure parseJSONObjectFromText returns null for natural language
      const parseJSON = await import('@elizaos/core').then((m) => m.parseJSONObjectFromText);
      vi.mocked(parseJSON).mockReturnValue(null);

      const message: Memory = {
        content: { text: 'I need you to collect my OpenAI and Anthropic API keys' },
        entityId: 'user-123',
      } as any;

      await requestSecretFormAction.handler(mockRuntime, message, {}, {}, mockCallback);

      const formCall = vi.mocked(mockFormService.createSecretForm).mock.calls[0];
      const request = formCall[0];

      expect(request.secrets).toHaveLength(2);
      const keys = request.secrets.map((s) => s.key);
      expect(keys).toContain('OPENAI_API_KEY');
      expect(keys).toContain('ANTHROPIC_API_KEY');
    });

    it('should handle webhook URL request', async () => {
      const message: Memory = {
        content: { text: 'Create a form for webhook configuration' },
        entityId: 'user-123',
      } as any;

      await requestSecretFormAction.handler(mockRuntime, message, {}, {}, mockCallback);

      const formCall = vi.mocked(mockFormService.createSecretForm).mock.calls[0];
      const request = formCall[0];

      expect(request.secrets[0]).toMatchObject({
        key: 'WEBHOOK_URL',
        config: {
          type: 'url',
          description: 'Webhook URL',
        },
      });
    });

    it('should parse JSON parameters', async () => {
      const parseJSON = await import('@elizaos/core').then((m) => m.parseJSONObjectFromText);
      vi.mocked(parseJSON).mockReturnValue({
        secrets: [
          {
            key: 'CUSTOM_KEY',
            description: 'Custom Secret',
            type: 'secret',
            required: false,
          },
        ],
        title: 'Custom Form',
        description: 'Custom Description',
        mode: 'inline',
        expiresIn: 600000,
      });

      const message: Memory = {
        content: { text: '{"secrets": [...]}' },
        entityId: 'user-123',
      } as any;

      await requestSecretFormAction.handler(mockRuntime, message, {}, {}, mockCallback);

      const formCall = vi.mocked(mockFormService.createSecretForm).mock.calls[0];
      const request = formCall[0];

      expect(request.title).toBe('Custom Form');
      expect(request.description).toBe('Custom Description');
      expect(request.mode).toBe('inline');
      expect(request.expiresIn).toBe(600000);
    });

    it('should handle custom expiration times', async () => {
      // Ensure parseJSONObjectFromText returns null for natural language
      const parseJSON = await import('@elizaos/core').then((m) => m.parseJSONObjectFromText);
      vi.mocked(parseJSON).mockReturnValue(null);

      const message: Memory = {
        content: { text: 'Create a form that expires in 5 minutes' },
        entityId: 'user-123',
      } as any;

      await requestSecretFormAction.handler(mockRuntime, message, {}, {}, mockCallback);

      const formCall = vi.mocked(mockFormService.createSecretForm).mock.calls[0];
      const request = formCall[0];

      expect(request.expiresIn).toBe(5 * 60 * 1000);
    });

    it('should handle hour expiration', async () => {
      // Ensure parseJSONObjectFromText returns null for natural language
      const parseJSON = await import('@elizaos/core').then((m) => m.parseJSONObjectFromText);
      vi.mocked(parseJSON).mockReturnValue(null);

      const message: Memory = {
        content: { text: 'Create a form that expires in 2 hours' },
        entityId: 'user-123',
      } as any;

      await requestSecretFormAction.handler(mockRuntime, message, {}, {}, mockCallback);

      const formCall = vi.mocked(mockFormService.createSecretForm).mock.calls[0];
      const request = formCall[0];

      expect(request.expiresIn).toBe(2 * 60 * 60 * 1000);
    });

    it('should use inline mode when specified', async () => {
      const message: Memory = {
        content: { text: 'Create a quick inline form for API key' },
        entityId: 'user-123',
      } as any;

      await requestSecretFormAction.handler(mockRuntime, message, {}, {}, mockCallback);

      const formCall = vi.mocked(mockFormService.createSecretForm).mock.calls[0];
      const request = formCall[0];

      expect(request.mode).toBe('inline');
    });

    it('should handle credit card request', async () => {
      // Ensure parseJSONObjectFromText returns null for natural language
      const parseJSON = await import('@elizaos/core').then((m) => m.parseJSONObjectFromText);
      vi.mocked(parseJSON).mockReturnValue(null);

      const message: Memory = {
        content: { text: 'Please request my credit card information' },
        entityId: 'user-123',
      } as any;

      await requestSecretFormAction.handler(mockRuntime, message, {}, {}, mockCallback);

      const formCall = vi.mocked(mockFormService.createSecretForm).mock.calls[0];
      const request = formCall[0];

      expect(request.secrets[0]).toMatchObject({
        key: 'CREDIT_CARD',
        config: {
          type: 'creditcard',
          description: 'Credit Card Number',
        },
      });
    });

    it('should handle service not available', async () => {
      mockRuntime.getService = vi.fn(() => null);

      const message: Memory = {
        content: { text: 'Request API key' },
        entityId: 'user-123',
      } as any;

      const result = await requestSecretFormAction.handler(
        mockRuntime,
        message,
        {},
        {},
        mockCallback
      );

      expect(result).toBe(false);
      expect(mockCallback).toHaveBeenCalledWith({
        text: 'Secret form service is not available.',
        error: true,
      });
    });

    it('should handle no secrets specified', async () => {
      const parseJSON = await import('@elizaos/core').then((m) => m.parseJSONObjectFromText);
      vi.mocked(parseJSON).mockReturnValue({
        secrets: [],
      });

      const message: Memory = {
        content: { text: '{"secrets": []}' },
        entityId: 'user-123',
      } as any;

      const result = await requestSecretFormAction.handler(
        mockRuntime,
        message,
        {},
        {},
        mockCallback
      );

      expect(result).toBe(false);
      expect(mockCallback).toHaveBeenCalledWith({
        text: 'Please specify what secrets you need to collect.',
        error: true,
      });
    });

    it('should handle form creation errors', async () => {
      // Make sure parseJSONObjectFromText returns null for natural language
      const parseJSON = await import('@elizaos/core').then((m) => m.parseJSONObjectFromText);
      vi.mocked(parseJSON).mockReturnValue(null);

      vi.mocked(mockFormService.createSecretForm).mockRejectedValue(
        new Error('Ngrok tunnel failed')
      );

      const message: Memory = {
        content: { text: 'Request API key' },
        entityId: 'user-123',
      } as any;

      const result = await requestSecretFormAction.handler(
        mockRuntime,
        message,
        {},
        {},
        mockCallback
      );

      expect(result).toBe(false);
      expect(mockCallback).toHaveBeenCalledWith({
        text: 'Error creating secret form: Ngrok tunnel failed',
        error: true,
      });
    });

    it('should add generic secret if no specific type found', async () => {
      // Make sure parseJSONObjectFromText returns null for natural language
      const parseJSON = await import('@elizaos/core').then((m) => m.parseJSONObjectFromText);
      vi.mocked(parseJSON).mockReturnValue(null);

      const message: Memory = {
        content: { text: 'Request some information' },
        entityId: 'user-123',
      } as any;

      await requestSecretFormAction.handler(mockRuntime, message, {}, {}, mockCallback);

      const formCall = vi.mocked(mockFormService.createSecretForm).mock.calls[0];
      const request = formCall[0];

      expect(request.secrets[0]).toMatchObject({
        key: 'SECRET_VALUE',
        config: {
          type: 'secret',
          description: 'Secret Information',
        },
      });
    });

    it('should handle submission callback', async () => {
      // Make sure parseJSONObjectFromText returns null for natural language
      const parseJSON = await import('@elizaos/core').then((m) => m.parseJSONObjectFromText);
      vi.mocked(parseJSON).mockReturnValue(null);

      const message: Memory = {
        content: { text: 'Request API key' },
        entityId: 'user-123',
      } as any;

      await requestSecretFormAction.handler(mockRuntime, message, {}, {}, mockCallback);

      // Verify createSecretForm was called
      expect(mockFormService.createSecretForm).toHaveBeenCalled();

      // Get the callback function
      const formCall = vi.mocked(mockFormService.createSecretForm).mock.calls[0];
      const submissionCallback = formCall[2];

      // Simulate form submission
      const submission = {
        formId: 'form-123',
        sessionId: 'session-123',
        data: { API_KEY: 'test-key' },
        submittedAt: Date.now(),
      };

      // Callback should not throw
      await expect(submissionCallback(submission)).resolves.not.toThrow();
    });
  });

  describe('examples', () => {
    it('should have valid examples', () => {
      expect(requestSecretFormAction.examples).toBeDefined();
      expect(requestSecretFormAction.examples).toHaveLength(3);

      // Check first example
      const firstExample = requestSecretFormAction.examples![0];
      expect(firstExample[0].name).toBe('user');
      expect(firstExample[0].content.text).toBe('I need you to collect my API keys');
      expect(firstExample[1].name).toBe('assistant');
      expect(firstExample[1].content.action).toBe('REQUEST_SECRET_FORM');
    });
  });
});
