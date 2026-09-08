import express, { Request, Response } from 'express';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({
    status: 'UP',
    timestamp: new Date().toISOString(),
    service: 'ts-service-health-checker',
    uptime: process.uptime()
  });
});

app.listen(PORT, () => {
  console.log(`[SERVER] Health check microservice running on port ${PORT}`);
});