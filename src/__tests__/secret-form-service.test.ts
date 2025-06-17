import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SecretFormService } from '../services/secret-form-service';
import { NgrokService } from '../services/ngrok-service';
import { EnhancedSecretManager } from '../enhanced-service';
import type { IAgentRuntime } from '@elizaos/core';
import type { SecretFormRequest, FormSubmission } from '../types/form';
import type { SecretContext } from '../types';
import express from 'express';
import request from 'supertest';

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
  };
});

// Mock express and server creation
vi.mock('express');
vi.mock('http', () => ({
  createServer: vi.fn(() => ({
    listen: vi.fn((port, cb) => cb()),
    close: vi.fn((cb) => cb?.()),
  })),
}));

// Mock file system imports
vi.mock('url', () => ({
  fileURLToPath: vi.fn(() => '/test/path/file.js'),
}));

vi.mock('path', () => ({
  dirname: vi.fn(() => '/test/path'),
}));

describe('SecretFormService', () => {
  let service: SecretFormService;
  let mockRuntime: IAgentRuntime;
  let mockNgrokService: NgrokService;
  let mockSecretsManager: EnhancedSecretManager;
  let mockApp: any;

  beforeEach(() => {
    vi.clearAllMocks();

    // Create mock Express app
    mockApp = {
      use: vi.fn(),
      get: vi.fn(),
      post: vi.fn(),
    };
    vi.mocked(express).mockReturnValue(mockApp);

    // Create mock services
    mockNgrokService = {
      createTunnel: vi.fn().mockResolvedValue({
        id: 'tunnel-123',
        url: 'https://test.ngrok.io',
      }),
      closeTunnel: vi.fn().mockResolvedValue(undefined),
      getTunnel: vi.fn(),
      getActiveTunnels: vi.fn().mockReturnValue([]),
    } as any;

    mockSecretsManager = {
      set: vi.fn().mockResolvedValue(true),
      get: vi.fn(),
    } as any;

    // Create mock runtime
    mockRuntime = {
      agentId: 'test-agent-123',
      getService: vi.fn((type: string) => {
        if (type === 'NGROK') return mockNgrokService;
        if (type === 'SECRETS') return mockSecretsManager;
        return null;
      }),
    } as any;

    service = new SecretFormService(mockRuntime);
  });

  afterEach(() => {
    // Clear any intervals
    vi.clearAllTimers();
  });

  describe('start', () => {
    it('should initialize with required services', async () => {
      await service.start();

      expect(mockRuntime.getService).toHaveBeenCalledWith('NGROK');
      expect(mockRuntime.getService).toHaveBeenCalledWith('SECRETS');
    });

    it('should throw if NgrokService is not available', async () => {
      mockRuntime.getService = vi.fn((type: string) => {
        if (type === 'NGROK') return null;
        return mockSecretsManager;
      });

      await expect(service.start()).rejects.toThrow('NgrokService is required');
    });

    it('should throw if SecretManager is not available', async () => {
      mockRuntime.getService = vi.fn((type: string) => {
        if (type === 'SECRETS') return null;
        return mockNgrokService;
      });

      await expect(service.start()).rejects.toThrow('EnhancedSecretManager is required');
    });

    it('should start cleanup interval', async () => {
      const setIntervalSpy = vi.spyOn(global, 'setInterval');

      await service.start();

      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 60 * 1000);
    });
  });

  describe('createSecretForm', () => {
    beforeEach(async () => {
      await service.start();
    });

    it('should create a basic secret form', async () => {
      const request: SecretFormRequest = {
        secrets: [
          {
            key: 'API_KEY',
            config: {
              type: 'api_key',
              description: 'Test API Key',
              required: true,
            },
          },
        ],
        title: 'Test Form',
      };

      const context: SecretContext = {
        level: 'user',
        userId: 'user-123',
        agentId: 'agent-123',
      };

      const result = await service.createSecretForm(request, context);

      expect(result).toEqual({
        url: expect.stringMatching(/^https:\/\/test\.ngrok\.io\/form\/.+$/),
        sessionId: expect.any(String),
      });

      expect(mockNgrokService.createTunnel).toHaveBeenCalledWith(
        expect.any(Number),
        expect.stringContaining('secret-form-'),
        undefined
      );
    });

    it('should handle custom expiration time', async () => {
      const request: SecretFormRequest = {
        secrets: [
          {
            key: 'API_KEY',
            config: { type: 'api_key' },
          },
        ],
        expiresIn: 60 * 60 * 1000, // 1 hour
      };

      const context: SecretContext = {
        level: 'global',
        agentId: 'agent-123',
      };

      await service.createSecretForm(request, context);

      expect(mockNgrokService.createTunnel).toHaveBeenCalledWith(
        expect.any(Number),
        expect.any(String),
        60 * 60 * 1000
      );
    });

    it('should setup routes correctly', async () => {
      const request: SecretFormRequest = {
        secrets: [
          {
            key: 'SECRET',
            config: { type: 'secret' },
          },
        ],
      };

      const context: SecretContext = {
        level: 'user',
        userId: 'user-123',
        agentId: 'agent-123',
      };

      const { sessionId } = await service.createSecretForm(request, context);

      expect(mockApp.get).toHaveBeenCalledWith(`/form/${sessionId}`, expect.any(Function));

      expect(mockApp.post).toHaveBeenCalledWith(
        `/api/form/${sessionId}/submit`,
        expect.any(Function)
      );

      expect(mockApp.get).toHaveBeenCalledWith(
        `/api/form/${sessionId}/status`,
        expect.any(Function)
      );
    });

    it('should handle form submission callback', async () => {
      const mockCallback = vi.fn();
      const request: SecretFormRequest = {
        secrets: [
          {
            key: 'API_KEY',
            config: { type: 'api_key' },
          },
        ],
      };

      const context: SecretContext = {
        level: 'user',
        userId: 'user-123',
        agentId: 'agent-123',
      };

      const { sessionId } = await service.createSecretForm(request, context, mockCallback);

      // Get the session to verify callback was stored
      const session = service.getSession(sessionId);
      expect(session?.callback).toBe(mockCallback);
    });

    it('should handle errors gracefully', async () => {
      mockNgrokService.createTunnel = vi.fn().mockRejectedValue(new Error('Tunnel failed'));

      const request: SecretFormRequest = {
        secrets: [
          {
            key: 'API_KEY',
            config: { type: 'api_key' },
          },
        ],
      };

      const context: SecretContext = {
        level: 'user',
        userId: 'user-123',
        agentId: 'agent-123',
      };

      await expect(service.createSecretForm(request, context)).rejects.toThrow('Tunnel failed');
    });
  });

  describe('form schema generation', () => {
    beforeEach(async () => {
      await service.start();
    });

    it('should generate correct schema for multiple secrets', async () => {
      const request: SecretFormRequest = {
        secrets: [
          {
            key: 'API_KEY',
            config: {
              type: 'api_key',
              description: 'API Key',
              required: true,
            },
          },
          {
            key: 'WEBHOOK_URL',
            config: {
              type: 'url',
              description: 'Webhook URL',
              required: false,
            },
          },
        ],
        title: 'Multi Secret Form',
        description: 'Test description',
        mode: 'inline',
      };

      const context: SecretContext = {
        level: 'user',
        userId: 'user-123',
        agentId: 'agent-123',
      };

      const { sessionId } = await service.createSecretForm(request, context);
      const session = service.getSession(sessionId);

      expect(session?.schema).toMatchObject({
        title: 'Multi Secret Form',
        description: 'Test description',
        mode: 'inline',
        fields: expect.arrayContaining([
          expect.objectContaining({
            name: 'API_KEY',
            type: 'password',
            required: true,
          }),
          expect.objectContaining({
            name: 'WEBHOOK_URL',
            type: 'url',
            required: false,
          }),
        ]),
      });
    });

    it('should apply field overrides', async () => {
      const request: SecretFormRequest = {
        secrets: [
          {
            key: 'CUSTOM_SECRET',
            config: {
              type: 'secret',
            },
            field: {
              type: 'textarea',
              rows: 10,
              placeholder: 'Custom placeholder',
            },
          },
        ],
      };

      const context: SecretContext = {
        level: 'user',
        userId: 'user-123',
        agentId: 'agent-123',
      };

      const { sessionId } = await service.createSecretForm(request, context);
      const session = service.getSession(sessionId);

      expect(session?.schema.fields[0]).toMatchObject({
        type: 'textarea',
        rows: 10,
        placeholder: 'Custom placeholder',
      });
    });
  });

  describe('form HTML generation', () => {
    beforeEach(async () => {
      await service.start();
    });

    it('should generate valid HTML with correct fields', async () => {
      const request: SecretFormRequest = {
        secrets: [
          {
            key: 'API_KEY',
            config: {
              type: 'api_key',
              description: 'Your API Key',
            },
          },
        ],
        title: 'API Configuration',
        description: 'Please enter your API key',
      };

      const context: SecretContext = {
        level: 'user',
        userId: 'user-123',
        agentId: 'agent-123',
      };

      const { sessionId } = await service.createSecretForm(request, context);

      // Simulate GET request to form endpoint
      let formHandler: any;
      const getCall = mockApp.get.mock.calls.find((call) => call[0] === `/form/${sessionId}`);
      if (getCall) {
        formHandler = getCall[1];
      }

      const mockReq = {};
      const mockRes = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      };

      formHandler(mockReq, mockRes);

      const html = mockRes.send.mock.calls[0][0];
      expect(html).toContain('API Configuration');
      expect(html).toContain('Please enter your API key');
      expect(html).toContain('id="API_KEY"');
      expect(html).toContain('type="password"');
    });

    it('should handle expired forms', async () => {
      const request: SecretFormRequest = {
        secrets: [
          {
            key: 'API_KEY',
            config: { type: 'api_key' },
          },
        ],
        expiresIn: 100, // Very short
      };

      const context: SecretContext = {
        level: 'user',
        userId: 'user-123',
        agentId: 'agent-123',
      };

      const { sessionId } = await service.createSecretForm(request, context);

      // Mark session as expired
      const session = service.getSession(sessionId);
      if (session) {
        session.status = 'expired';
      }

      // Get form handler
      let formHandler: any;
      const getCall = mockApp.get.mock.calls.find((call) => call[0] === `/form/${sessionId}`);
      if (getCall) {
        formHandler = getCall[1];
      }

      const mockReq = {};
      const mockRes = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      };

      formHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(410);
      expect(mockRes.send).toHaveBeenCalledWith('This form has expired or been completed.');
    });
  });

  describe('form submission handling', () => {
    beforeEach(async () => {
      await service.start();
    });

    it('should handle valid submission', async () => {
      const mockCallback = vi.fn();
      const request: SecretFormRequest = {
        secrets: [
          {
            key: 'API_KEY',
            config: {
              type: 'api_key',
              required: true,
            },
          },
        ],
      };

      const context: SecretContext = {
        level: 'user',
        userId: 'user-123',
        agentId: 'agent-123',
      };

      const { sessionId } = await service.createSecretForm(request, context, mockCallback);

      // Get submit handler
      let submitHandler: any;
      const postCall = mockApp.post.mock.calls.find(
        (call) => call[0] === `/api/form/${sessionId}/submit`
      );
      if (postCall) {
        submitHandler = postCall[1];
      }

      const mockReq = {
        body: { API_KEY: 'test-api-key-123' },
        ip: '127.0.0.1',
        get: vi.fn(() => 'Mozilla/5.0'),
      };
      const mockRes = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      };

      await submitHandler(mockReq, mockRes);

      expect(mockSecretsManager.set).toHaveBeenCalledWith(
        'API_KEY',
        'test-api-key-123',
        context,
        expect.any(Object)
      );

      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { API_KEY: 'test-api-key-123' },
          ipAddress: '127.0.0.1',
        })
      );

      expect(mockRes.json).toHaveBeenCalledWith({
        success: true,
        message: expect.any(String),
      });
    });

    it('should validate required fields', async () => {
      const request: SecretFormRequest = {
        secrets: [
          {
            key: 'API_KEY',
            config: {
              type: 'api_key',
              required: true,
            },
          },
        ],
      };

      const context: SecretContext = {
        level: 'user',
        userId: 'user-123',
        agentId: 'agent-123',
      };

      const { sessionId } = await service.createSecretForm(request, context);

      // Get submit handler
      let submitHandler: any;
      const postCall = mockApp.post.mock.calls.find(
        (call) => call[0] === `/api/form/${sessionId}/submit`
      );
      if (postCall) {
        submitHandler = postCall[1];
      }

      const mockReq = {
        body: {}, // Missing required field
        ip: '127.0.0.1',
        get: vi.fn(),
      };
      const mockRes = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      };

      await submitHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        errors: expect.objectContaining({
          API_KEY: expect.any(String),
        }),
      });
    });

    it('should close session after max submissions', async () => {
      const request: SecretFormRequest = {
        secrets: [
          {
            key: 'API_KEY',
            config: { type: 'api_key' },
          },
        ],
        maxSubmissions: 1,
      };

      const context: SecretContext = {
        level: 'user',
        userId: 'user-123',
        agentId: 'agent-123',
      };

      const { sessionId } = await service.createSecretForm(request, context);

      // Get submit handler
      let submitHandler: any;
      const postCall = mockApp.post.mock.calls.find(
        (call) => call[0] === `/api/form/${sessionId}/submit`
      );
      if (postCall) {
        submitHandler = postCall[1];
      }

      const mockReq = {
        body: { API_KEY: 'test-key' },
        ip: '127.0.0.1',
        get: vi.fn(),
      };
      const mockRes = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      };

      await submitHandler(mockReq, mockRes);

      // Session should be marked as completed
      const session = service.getSession(sessionId);
      expect(session?.status).toBe('completed');
    });
  });

  describe('session management', () => {
    beforeEach(async () => {
      await service.start();
    });

    it('should track multiple sessions', async () => {
      const request: SecretFormRequest = {
        secrets: [
          {
            key: 'API_KEY',
            config: { type: 'api_key' },
          },
        ],
      };

      const context: SecretContext = {
        level: 'user',
        userId: 'user-123',
        agentId: 'agent-123',
      };

      const session1 = await service.createSecretForm(request, context);
      const session2 = await service.createSecretForm(request, context);

      expect(service.getSession(session1.sessionId)).toBeTruthy();
      expect(service.getSession(session2.sessionId)).toBeTruthy();
      expect(session1.sessionId).not.toBe(session2.sessionId);
    });

    it('should close session properly', async () => {
      const request: SecretFormRequest = {
        secrets: [
          {
            key: 'API_KEY',
            config: { type: 'api_key' },
          },
        ],
      };

      const context: SecretContext = {
        level: 'user',
        userId: 'user-123',
        agentId: 'agent-123',
      };

      const { sessionId } = await service.createSecretForm(request, context);
      const session = service.getSession(sessionId);

      await service.closeSession(sessionId);

      expect(mockNgrokService.closeTunnel).toHaveBeenCalledWith(session?.tunnelId);
      expect(service.getSession(sessionId)).toBeNull();
    });

    it('should handle cleanup of expired sessions', async () => {
      vi.useFakeTimers();

      const request: SecretFormRequest = {
        secrets: [
          {
            key: 'API_KEY',
            config: { type: 'api_key' },
          },
        ],
        expiresIn: 1000, // 1 second
      };

      const context: SecretContext = {
        level: 'user',
        userId: 'user-123',
        agentId: 'agent-123',
      };

      const { sessionId } = await service.createSecretForm(request, context);

      // Advance time past expiration
      vi.advanceTimersByTime(2000);

      // Manually trigger cleanup (normally done by interval)
      await (service as any).cleanupExpiredSessions();

      expect(service.getSession(sessionId)).toBeNull();

      vi.useRealTimers();
    });
  });

  describe('stop', () => {
    beforeEach(async () => {
      await service.start();
    });

    it('should close all sessions on stop', async () => {
      const request: SecretFormRequest = {
        secrets: [
          {
            key: 'API_KEY',
            config: { type: 'api_key' },
          },
        ],
      };

      const context: SecretContext = {
        level: 'user',
        userId: 'user-123',
        agentId: 'agent-123',
      };

      const session1 = await service.createSecretForm(request, context);
      const session2 = await service.createSecretForm(request, context);

      await service.stop();

      expect(service.getSession(session1.sessionId)).toBeNull();
      expect(service.getSession(session2.sessionId)).toBeNull();
      expect(mockNgrokService.closeTunnel).toHaveBeenCalledTimes(2);
    });
  });

  describe('security', () => {
    beforeEach(async () => {
      await service.start();
    });

    it('should sanitize HTML in form generation', async () => {
      const request: SecretFormRequest = {
        secrets: [
          {
            key: 'API_KEY',
            config: {
              type: 'api_key',
              description: '<script>alert("XSS")</script>',
            },
          },
        ],
        title: '<img src=x onerror=alert("XSS")>',
        description: '"><script>alert("XSS")</script>',
      };

      const context: SecretContext = {
        level: 'user',
        userId: 'user-123',
        agentId: 'agent-123',
      };

      const { sessionId } = await service.createSecretForm(request, context);

      // Get form handler and generate HTML
      let formHandler: any;
      const getCall = mockApp.get.mock.calls.find((call) => call[0] === `/form/${sessionId}`);
      if (getCall) {
        formHandler = getCall[1];
      }

      const mockReq = {};
      const mockRes = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      };

      formHandler(mockReq, mockRes);

      const html = mockRes.send.mock.calls[0][0];

      // HTML should be escaped
      expect(html).toContain('&lt;script&gt;');
      expect(html).not.toContain('<script>alert("XSS")</script>');
    });
  });
});
