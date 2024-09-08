import express, { Response } from 'express';
import ExpressWs from 'express-ws';
import { WebSocket } from 'ws';
import VoiceResponse from 'twilio/lib/twiml/VoiceResponse';
import { Llm } from './llm';
import { Stream } from './stream';
import { TextToSpeech } from './text-to-speech';
import * as path from 'path';
import * as fs from 'fs/promises';
import { isPromise } from 'util/types';
const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");

const app = ExpressWs(express()).app;
const PORT: number = parseInt(process.env.PORT || '8080');

const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

export const startApp = () => {
  
  app.post('/call/incoming', (_, res: Response) => {
    const twiml = new VoiceResponse();

    twiml.connect().stream({
      url: `wss://${process.env.SERVER_DOMAIN}/call/connection`,
    });

    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml.toString());
  });

  app.ws('/call/connection', (ws: WebSocket) => {
    let isInitialGreetingPlaying = false;
    let isSpeaking = false; 
    console.log('Twilio -> Connection opened'.underline.green);

    ws.on('error', console.error);

    const llm = new Llm();
    const stream = new Stream(ws);
    const textToSpeech = new TextToSpeech();

    let streamSid: string;
    let callSid: string;
    let marks: string[] = [];

    const connection = deepgram.listen.live({
      smart_format: true,
      model: 'nova-2-phonecall',
      language: 'en-US',
      encoding: 'mulaw',
      sample_rate: 8000,
      diarize: true,
      punctuate: true,
      channels:1,
      interim_results: true,
      endpointing: 100,
      
    });

    let finalResult = '';
    let speechFinal = false;

    connection.on(LiveTranscriptionEvents.Open, () => {
      // Listen for any transcripts received from Deepgram and write them to the console.
      connection.on(LiveTranscriptionEvents.Transcript, (data:any) => {
       // console.dir(data, { depth: null });

        const speakers = data.channel.alternatives[0].words?.map((word: { speaker: number }) => word.speaker);
        const alternatives = data.channel?.alternatives;
        let text = '';
        if (alternatives) {
          text = alternatives[0]?.transcript;
        }
        // if (marks.length > 0 && isSpeaking && speakers.includes(1) )
        //   {
        //    console.log('Utterance detected (isFinal + silence)'.magenta);
        //    // ... perform actions like clearing the stream ...
        //    ws.send(
        //      JSON.stringify({
        //        streamSid,
        //        event: 'clear',
        //      }),
        //    );
        //  }
        //if speaker is user then send to llm 
        if (speakers.includes(0)) return;
        
        // if (data.is_final && data.speech_final) {
        //   const transcript = data.channel.alternatives[0].transcript;
        //   console.log(`User: ${transcript}`.yellow);
        //   llm.completion(transcript);      
        // } 
        if (data.is_final === true && text.trim().length > 0) {
          finalResult += ` ${text}`;
          // if speech_final and is_final that means this text is accurate and it's a natural pause in the speakers speech. We need to send this to the assistant for processing
          if (data.speech_final === true) {
            speechFinal = true; // this will prevent a utterance end which shows up after speechFinal from sending another response
            console.log(`User: ${finalResult}`.yellow);
            llm.completion(finalResult);  
            finalResult = '';
          } else {
            // if we receive a message without speechFinal reset speechFinal to false, this will allow any subsequent utteranceEnd messages to properly indicate the end of a message
            speechFinal = false;
          }
        }   
      });

      // Listen for the connection to close.
      connection.on(LiveTranscriptionEvents.Close, () => {
        console.log("Connection closed.");
      });

    });
    
    // Incoming from MediaStream
    ws.on('message', async (data: string) => {
      const message: {
        event: string;
        start?: { streamSid: string; callSid: string };
        media?: { payload: string };
        mark?: { name: string };
        sequenceNumber?: number;
      } = JSON.parse(data);

      if (message.event === 'start' && message.start) {
        streamSid = message.start.streamSid;
        callSid = message.start.callSid;
        stream.setStreamSid(streamSid);
        llm.setCallSid(callSid);
        console.log(
          `Twilio -> Starting Media Stream for ${streamSid}`.underline.red,
        );
        
        textToSpeech.generate({
          partialResponseIndex: null,
          partialResponse: 'Hi, my name is Emma. How can I help you?',
        });

        // const filePath = path.join(__dirname, 'test.m4a');

        // try {
        //   const audioBuffer = await fs.readFile(filePath);
        //   connection.send(audioBuffer);
        // } catch (err) {
        //   console.error('Error reading audio file:', err);
        // }

      } else if (message.event === 'media' && message.media) {
        
        const audioBuffer = Buffer.from(message.media.payload, 'base64');
        connection.send(audioBuffer);

      } else if (message.event === 'mark' && message.mark) {
        const label: string = message.mark.name;

        console.log(
          `Twilio -> Audio completed mark (${message.sequenceNumber}): ${label}`
            .red,
        );
        isSpeaking = false;
        marks = marks.filter((m: string) => m !== message.mark?.name);
      } else if (message.event === 'stop') {
        console.log(`Twilio -> Media stream ${streamSid} ended.`.underline.red);
      }
    });

    llm.on('llmreply', async (llmReply: { partialResponse: string }) => {
      console.log(`LLM -> TTS: ${llmReply.partialResponse}`.green);
      textToSpeech.generate(llmReply);
    });

    textToSpeech.on(
      'speech',
      (responseIndex: number, audio: string, label: string) => {

        isSpeaking = true;
        console.log(`TTS -> TWILIO: ${label}`.blue);
        stream.buffer(responseIndex, audio);
       
      },
    );

    stream.on('audiosent', (markLabel: string) => {
      marks.push(markLabel);
    });
  });

  app.listen(PORT, () => {
    console.log(`Local: http://localhost:${PORT}`);
    console.log(`Remote: https://${process.env.SERVER_DOMAIN}`);
  });
};
