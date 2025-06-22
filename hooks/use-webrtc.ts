"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import { ref, push, onValue, set, remove, get, off } from "firebase/database"
import { database } from "@/lib/firebase"
import { useAuth } from "@/contexts/auth-context"
import { useToast } from "@/components/ui/use-toast"

interface UseWebRTCProps {
  contactId: string
  callType: "voice" | "video"
  isIncoming?: boolean
}

type CallStatus = "idle" | "calling" | "ringing" | "connecting" | "connected" | "ended" | "rejected"

export const useWebRTC = ({ contactId, callType, isIncoming = false }: UseWebRTCProps) => {
  const { currentUser } = useAuth()
  const { toast } = useToast()

  // WebRTC states
  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null)
  const [peerConnection, setPeerConnection] = useState<RTCPeerConnection | null>(null)
  const [isConnected, setIsConnected] = useState(false)
  const [callStatus, setCallStatus] = useState<CallStatus>("idle")

  // Control states
  const [isMuted, setIsMuted] = useState(false)
  const [isVideoEnabled, setIsVideoEnabled] = useState(callType === "video")
  const [isSpeakerOn, setIsSpeakerOn] = useState(false)

  // Refs
  const callIdRef = useRef<string | null>(null)
  const statusListenerRef = useRef<any>(null)
  const answerListenerRef = useRef<any>(null)
  const candidatesListenerRef = useRef<any>(null)

  // WebRTC Configuration
  const rtcConfig: RTCConfiguration = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun2.l.google.com:19302" },
      { urls: "stun:stun3.l.google.com:19302" },
      { urls: "stun:stun4.l.google.com:19302" },
    ],
    iceCandidatePoolSize: 10,
  }

  // Initialize media stream
  const initializeMedia = useCallback(async () => {
    try {
      console.log("Initializing media for", callType)
      const constraints: MediaStreamConstraints = {
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video:
          callType === "video"
            ? {
                width: { ideal: 1280 },
                height: { ideal: 720 },
                frameRate: { ideal: 30 },
                facingMode: "user",
              }
            : false,
      }

      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      console.log("Media stream obtained:", stream)
      setLocalStream(stream)
      return stream
    } catch (error) {
      console.error("Error accessing media devices:", error)
      toast({
        title: "Media Access Error",
        description: "Could not access camera/microphone. Please check permissions.",
        variant: "destructive",
      })
      throw error
    }
  }, [callType, toast])

  // Create peer connection
  const createPeerConnection = useCallback(() => {
    console.log("Creating peer connection")
    const pc = new RTCPeerConnection(rtcConfig)

    pc.onicecandidate = (event) => {
      if (event.candidate && callIdRef.current) {
        console.log("Sending ICE candidate")
        const candidateRef = ref(database, `calls/${callIdRef.current}/candidates/${currentUser?.uid}`)
        push(candidateRef, event.candidate.toJSON())
      }
    }

    pc.ontrack = (event) => {
      console.log("Received remote stream:", event.streams[0])
      setRemoteStream(event.streams[0])
    }

    pc.onconnectionstatechange = () => {
      console.log("Connection state changed:", pc.connectionState)
      if (pc.connectionState === "connected") {
        setIsConnected(true)
        setCallStatus("connected")
      } else if (pc.connectionState === "disconnected" || pc.connectionState === "failed") {
        setIsConnected(false)
        if (callStatus !== "ended") {
          setCallStatus("ended")
        }
      }
    }

    pc.oniceconnectionstatechange = () => {
      console.log("ICE connection state changed:", pc.iceConnectionState)
      if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
        setIsConnected(true)
        setCallStatus("connected")
      } else if (pc.iceConnectionState === "failed" || pc.iceConnectionState === "disconnected") {
        if (callStatus !== "ended") {
          setCallStatus("ended")
        }
      }
    }

    setPeerConnection(pc)
    return pc
  }, [currentUser?.uid, callStatus])

  // Start outgoing call
  const startCall = useCallback(async () => {
    if (!currentUser) return

    try {
      console.log("Starting outgoing call")
      setCallStatus("calling")

      const stream = await initializeMedia()
      const pc = createPeerConnection()

      // Add local stream to peer connection
      stream.getTracks().forEach((track) => {
        console.log("Adding track to peer connection:", track.kind)
        pc.addTrack(track, stream)
      })

      // Create call document in Firebase
      const callRef = push(ref(database, "calls"))
      callIdRef.current = callRef.key

      console.log("Creating call with ID:", callRef.key)

      const callData = {
        callerId: currentUser.uid,
        calleeId: contactId,
        type: callType,
        status: "calling",
        createdAt: Date.now(),
      }

      await set(callRef, callData)
      console.log("Call document created successfully")

      // Create offer
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      console.log("Offer created and set as local description")

      // Save offer to Firebase
      await set(ref(database, `calls/${callRef.key}/offer`), {
        type: offer.type,
        sdp: offer.sdp,
      })
      console.log("Offer saved to Firebase")

      // Listen for answer
      const answerRef = ref(database, `calls/${callRef.key}/answer`)
      answerListenerRef.current = answerRef

      const handleAnswer = async (snapshot: any) => {
        if (snapshot.exists() && pc.currentRemoteDescription === null) {
          console.log("Received answer:", snapshot.val())
          const answer = snapshot.val()
          await pc.setRemoteDescription(new RTCSessionDescription(answer))
          setCallStatus("connecting")
        }
      }

      onValue(answerRef, handleAnswer)

      // Listen for ICE candidates
      const candidatesRef = ref(database, `calls/${callRef.key}/candidates/${contactId}`)
      candidatesListenerRef.current = candidatesRef

      const handleCandidates = (snapshot: any) => {
        if (snapshot.exists()) {
          Object.values(snapshot.val()).forEach(async (candidateData: any) => {
            if (candidateData && pc.remoteDescription) {
              console.log("Adding ICE candidate")
              await pc.addIceCandidate(new RTCIceCandidate(candidateData))
            }
          })
        }
      }

      onValue(candidatesRef, handleCandidates)

      // Listen for call status changes
      const statusRef = ref(database, `calls/${callRef.key}/status`)
      statusListenerRef.current = statusRef

      const handleStatusChange = (snapshot: any) => {
        if (snapshot.exists()) {
          const status = snapshot.val()
          console.log("Call status changed to:", status)
          setCallStatus(status)

          if (status === "rejected") {
            console.log("Call was rejected")
            cleanup()
          } else if (status === "ended") {
            console.log("Call was ended")
            cleanup()
          } else if (status === "accepted") {
            console.log("Call was accepted")
            setCallStatus("connecting")
          }
        }
      }

      onValue(statusRef, handleStatusChange)
    } catch (error) {
      console.error("Error starting call:", error)
      setCallStatus("ended")
      cleanup()
    }
  }, [currentUser, contactId, callType, initializeMedia, createPeerConnection])

  // Accept incoming call
  const acceptCall = useCallback(async () => {
    if (!currentUser || !callIdRef.current) {
      console.log("Cannot accept call - missing user or call ID")
      return
    }

    console.log("Accepting incoming call:", callIdRef.current)

    try {
      setCallStatus("connecting")

      const stream = await initializeMedia()
      const pc = createPeerConnection()

      // Add local stream to peer connection
      stream.getTracks().forEach((track) => {
        console.log("Adding track to peer connection:", track.kind)
        pc.addTrack(track, stream)
      })

      // Get offer from Firebase
      const offerRef = ref(database, `calls/${callIdRef.current}/offer`)
      const offerSnapshot = await get(offerRef)

      if (offerSnapshot.exists()) {
        const offer = offerSnapshot.val()
        console.log("Got offer:", offer)
        await pc.setRemoteDescription(new RTCSessionDescription(offer))

        // Create answer
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        console.log("Answer created and set as local description")

        // Save answer to Firebase
        await set(ref(database, `calls/${callIdRef.current}/answer`), {
          type: answer.type,
          sdp: answer.sdp,
        })
        console.log("Answer saved to Firebase")

        // Listen for ICE candidates
        const candidatesRef = ref(database, `calls/${callIdRef.current}/candidates/${contactId}`)
        candidatesListenerRef.current = candidatesRef

        const handleCandidates = (snapshot: any) => {
          if (snapshot.exists()) {
            Object.values(snapshot.val()).forEach(async (candidateData: any) => {
              if (candidateData && pc.remoteDescription) {
                console.log("Adding ICE candidate")
                await pc.addIceCandidate(new RTCIceCandidate(candidateData))
              }
            })
          }
        }

        onValue(candidatesRef, handleCandidates)

        console.log("Call accepted successfully")
      } else {
        console.error("No offer found for call")
        setCallStatus("ended")
      }
    } catch (error) {
      console.error("Error accepting call:", error)
      setCallStatus("ended")
      cleanup()
    }
  }, [currentUser, contactId, initializeMedia, createPeerConnection])

  // Reject call
  const rejectCall = useCallback(async () => {
    if (!callIdRef.current) return

    console.log("Rejecting call:", callIdRef.current)
    try {
      await set(ref(database, `calls/${callIdRef.current}/status`), "rejected")
      setCallStatus("rejected")
      cleanup()
    } catch (error) {
      console.error("Error rejecting call:", error)
    }
  }, [])

  // End call
  const endCall = useCallback(async () => {
    console.log("Ending call:", callIdRef.current)
    if (callIdRef.current) {
      try {
        await set(ref(database, `calls/${callIdRef.current}/status`), "ended")
      } catch (error) {
        console.error("Error ending call:", error)
      }
    }
    setCallStatus("ended")
    cleanup()
  }, [])

  // Cleanup function
  const cleanup = useCallback(() => {
    console.log("Cleaning up WebRTC resources")

    // Stop local stream
    if (localStream) {
      localStream.getTracks().forEach((track) => {
        track.stop()
        console.log("Stopped track:", track.kind)
      })
      setLocalStream(null)
    }

    // Close peer connection
    if (peerConnection) {
      peerConnection.close()
      setPeerConnection(null)
      console.log("Peer connection closed")
    }

    // Clean up Firebase listeners
    if (statusListenerRef.current) {
      off(statusListenerRef.current)
      statusListenerRef.current = null
    }
    if (answerListenerRef.current) {
      off(answerListenerRef.current)
      answerListenerRef.current = null
    }
    if (candidatesListenerRef.current) {
      off(candidatesListenerRef.current)
      candidatesListenerRef.current = null
    }

    // Clean up Firebase call data
    if (callIdRef.current) {
      remove(ref(database, `calls/${callIdRef.current}`))
      callIdRef.current = null
    }

    setRemoteStream(null)
    setIsConnected(false)
  }, [localStream, peerConnection])

  // Control functions
  const toggleMute = useCallback(() => {
    if (localStream) {
      const audioTrack = localStream.getAudioTracks()[0]
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled
        setIsMuted(!audioTrack.enabled)
        console.log("Audio muted:", !audioTrack.enabled)
      }
    }
  }, [localStream])

  const toggleVideo = useCallback(() => {
    if (localStream) {
      const videoTrack = localStream.getVideoTracks()[0]
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled
        setIsVideoEnabled(videoTrack.enabled)
        console.log("Video enabled:", videoTrack.enabled)
      }
    }
  }, [localStream])

  const toggleSpeaker = useCallback(() => {
    setIsSpeakerOn(!isSpeakerOn)
    console.log("Speaker on:", !isSpeakerOn)
  }, [isSpeakerOn])

  // Initialize for incoming calls
  useEffect(() => {
    if (isIncoming && contactId) {
      console.log("Setting up incoming call listener")
      const callsRef = ref(database, "calls")

      const handleIncomingCall = (snapshot: any) => {
        if (snapshot.exists()) {
          const calls = snapshot.val()
          Object.entries(calls).forEach(([callId, callData]: [string, any]) => {
            if (
              callData.calleeId === currentUser?.uid &&
              callData.callerId === contactId &&
              (callData.status === "calling" || callData.status === "accepted")
            ) {
              console.log("Found incoming call:", callId, callData.status)
              callIdRef.current = callId
              if (callData.status === "calling") {
                setCallStatus("ringing")
              } else if (callData.status === "accepted") {
                setCallStatus("connecting")
              }
            }
          })
        }
      }

      onValue(callsRef, handleIncomingCall)

      return () => {
        off(callsRef)
      }
    }
  }, [isIncoming, contactId, currentUser?.uid])

  // Auto-start call for outgoing calls
  useEffect(() => {
    if (!isIncoming && contactId && callStatus === "idle") {
      console.log("Auto-starting outgoing call")
      startCall()
    }
  }, [isIncoming, contactId, callStatus, startCall])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      console.log("Component unmounting, cleaning up")
      cleanup()
    }
  }, [cleanup])

  return {
    localStream,
    remoteStream,
    isConnected,
    callStatus,
    isMuted,
    isVideoEnabled,
    isSpeakerOn,
    toggleMute,
    toggleVideo,
    toggleSpeaker,
    acceptCall,
    rejectCall,
    endCall,
    startCall,
  }
}
