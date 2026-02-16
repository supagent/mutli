/**
 * Telegram controller.
 *
 * - POST /telegram/webhook — Receives webhook requests from Telegram Bot API
 * - POST /telegram/connect-code — Creates a short code for QR deep link flow
 */

import { Body, Controller, HttpException, HttpStatus, Inject, Logger, Post, Req, Res, Headers } from "@nestjs/common";
import { TelegramService } from "./telegram.service.js";
import type { ConnectionInfo } from "@multica/store/connection";

// Minimal Express types for webhook handling
interface ExpressRequest {
  body: unknown;
  header: (name: string) => string | undefined;
}

interface ExpressResponse {
  status: (code: number) => ExpressResponse;
  json: (data: unknown) => void;
  headersSent: boolean;
}

@Controller("telegram")
export class TelegramController {
  private readonly logger = new Logger(TelegramController.name);

  constructor(@Inject(TelegramService) private readonly telegramService: TelegramService) {}

  @Post("connect-code")
  async createConnectCode(
    @Body() body: {
      gateway: string;
      hubId: string;
      agentId: string;
      conversationId?: string;
      sessionId?: string;
      token: string;
      expires: number;
    },
  ): Promise<{ code: string; botUsername: string }> {
    if (!this.telegramService.isConfigured()) {
      throw new HttpException("Telegram bot not configured", HttpStatus.SERVICE_UNAVAILABLE);
    }

    const botUsername = this.telegramService.getBotUsername();
    if (!botUsername) {
      throw new HttpException("Bot username not available", HttpStatus.INTERNAL_SERVER_ERROR);
    }

    const connectionInfo: ConnectionInfo = {
      type: "multica-connect",
      gateway: body.gateway,
      hubId: body.hubId,
      agentId: body.agentId,
      ...((body.sessionId ?? body.conversationId) ? { conversationId: body.sessionId ?? body.conversationId } : {}),
      token: body.token,
      expires: body.expires,
    };

    const code = this.telegramService.createConnectCode(connectionInfo);
    this.logger.debug(`Created connect code: ${code}`);

    return { code, botUsername };
  }

  @Post("webhook")
  async handleWebhook(
    @Req() req: ExpressRequest,
    @Res() res: ExpressResponse,
    @Headers("x-telegram-bot-api-secret-token") secretToken?: string
  ): Promise<void> {
    // Check if Telegram is configured
    if (!this.telegramService.isConfigured()) {
      this.logger.warn("Telegram webhook called but bot not configured");
      res.status(503).json({ error: "Telegram not configured" });
      return;
    }

    // Validate secret token if configured
    const expectedToken = process.env["TELEGRAM_WEBHOOK_SECRET_TOKEN"];
    if (expectedToken && secretToken !== expectedToken) {
      this.logger.warn("Invalid Telegram webhook secret token");
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    // Get grammY webhook callback
    const callback = this.telegramService.getWebhookCallback();
    if (!callback) {
      res.status(503).json({ error: "Telegram not configured" });
      return;
    }

    // Let grammY handle the request
    try {
      await callback(req, res);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Telegram webhook error: ${message}`);
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  }
}
