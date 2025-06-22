"use client"

import { useEffect, useState, useRef } from "react"
import { motion, AnimatePresence } from "framer-motion"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Phone, PhoneOff, Video } from "lucide-react"
import { useAuth } from "@/contexts/auth-context"
import { ref, onValue, set, get, off } from "firebase/database"
import { database } from "@/lib/firebase"

interface IncomingCall {
  id: string
  callerId: string
  callerName: string
  callerAvatar?: string
  type: "voice" | "video"
  timestamp: number
}

interface IncomingCallNotificationProps {
  onAccept: (call: IncomingCall) => void
  onReject: (callId: string) => void
}

export default function IncomingCallNotification({ onAccept, onReject }: IncomingCallNotificationProps) {
  const { currentUser } = useAuth()
  const [incomingCall, setIncomingCall] = useState<IncomingCall | null>(null)
  const [isRinging, setIsRinging] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const callListenerRef = useRef<any>(null)
  const statusListenerRef = useRef<any>(null)

  // Listen for incoming calls - PERSISTENT LISTENER
  useEffect(() => {
    if (!currentUser) return

    console.log("Setting up PERSISTENT incoming call listener for user:", currentUser.uid)

    const callsRef = ref(database, "calls")

    const handleCallsUpdate = async (snapshot: any) => {
      if (!snapshot.exists()) {
        console.log("No calls in database")
        return
      }

      const calls = snapshot.val()
      console.log("Checking calls for incoming:", calls)

      let foundIncomingCall: IncomingCall | null = null

      // Look for incoming calls for current user
      for (const [callId, callData] of Object.entries(calls) as [string, any][]) {
        console.log("Checking call:", callId, callData)

        if (
          callData.calleeId === currentUser.uid &&
          callData.status === "calling" &&
          Date.now() - callData.createdAt < 300000 // 5 minutes max
        ) {
          console.log("Found incoming call for current user:", callId)

          try {
            // Get caller info
            const callerRef = ref(database, `users/${callData.callerId}`)
            const callerSnapshot = await get(callerRef)

            if (callerSnapshot.exists()) {
              const callerData = callerSnapshot.val()
              foundIncomingCall = {
                id: callId,
                callerId: callData.callerId,
                callerName: callerData.name || callerData.email?.split("@")[0] || "Unknown",
                callerAvatar: callerData.avatar,
                type: callData.type,
                timestamp: callData.createdAt,
              }
              console.log("Created incoming call object:", foundIncomingCall)

              // Set up status listener for this specific call
              if (statusListenerRef.current) {
                off(statusListenerRef.current)
              }

              const callStatusRef = ref(database, `calls/${callId}/status`)
              statusListenerRef.current = callStatusRef

              const handleStatusChange = (statusSnapshot: any) => {
                if (statusSnapshot.exists()) {
                  const status = statusSnapshot.val()
                  console.log("Call status changed to:", status)

                  if (status === "ended" || status === "rejected") {
                    console.log("Call ended/rejected, hiding notification")
                    setIncomingCall(null)
                    setIsRinging(false)
                    setIsProcessing(false)
                  }
                }
              }

              onValue(callStatusRef, handleStatusChange)
            }
          } catch (error) {
            console.error("Error getting caller info:", error)
          }
          break
        }
      }

      console.log("Setting incoming call:", foundIncomingCall)
      if (foundIncomingCall && !isProcessing) {
        setIncomingCall(foundIncomingCall)
        setIsRinging(true)
      } else if (!foundIncomingCall) {
        setIncomingCall(null)
        setIsRinging(false)
        setIsProcessing(false)
      }
    }

    callListenerRef.current = callsRef
    onValue(callsRef, handleCallsUpdate)

    return () => {
      console.log("Cleaning up incoming call listeners")
      if (callListenerRef.current) {
        off(callListenerRef.current)
      }
      if (statusListenerRef.current) {
        off(statusListenerRef.current)
      }
    }
  }, [currentUser, isProcessing])

  // Play ringtone
  useEffect(() => {
    let ringtoneInterval: NodeJS.Timeout | null = null
    let audioContext: AudioContext | null = null

    if (isRinging && !isProcessing) {
      // Create a simple ringtone using Web Audio API
      audioContext = new (window.AudioContext || (window as any).webkitAudioContext)()

      const playRingtone = () => {
        if (!audioContext) return

        const oscillator = audioContext.createOscillator()
        const gainNode = audioContext.createGain()

        oscillator.connect(gainNode)
        gainNode.connect(audioContext.destination)

        oscillator.frequency.setValueAtTime(800, audioContext.currentTime)
        oscillator.frequency.setValueAtTime(600, audioContext.currentTime + 0.5)

        gainNode.gain.setValueAtTime(0.1, audioContext.currentTime)
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 1)

        oscillator.start(audioContext.currentTime)
        oscillator.stop(audioContext.currentTime + 1)
      }

      ringtoneInterval = setInterval(playRingtone, 2000)
      playRingtone() // Play immediately
    }

    return () => {
      if (ringtoneInterval) {
        clearInterval(ringtoneInterval)
      }
      if (audioContext) {
        audioContext.close()
      }
    }
  }, [isRinging, isProcessing])

  const handleAccept = async () => {
    if (!incomingCall || isProcessing) return

    console.log("ACCEPTING CALL:", incomingCall.id)
    setIsProcessing(true)

    try {
      // Set call status to accepted
      await set(ref(database, `calls/${incomingCall.id}/status`), "accepted")
      console.log("Call status set to accepted")

      setIsRinging(false)
      onAccept(incomingCall)

      // Don't clear the call immediately, let the calling interface handle it
      setTimeout(() => {
        setIncomingCall(null)
        setIsProcessing(false)
      }, 1000)
    } catch (error) {
      console.error("Error accepting call:", error)
      setIsProcessing(false)
    }
  }

  const handleReject = async () => {
    if (!incomingCall || isProcessing) return

    console.log("REJECTING CALL:", incomingCall.id)
    setIsProcessing(true)

    try {
      await set(ref(database, `calls/${incomingCall.id}/status`), "rejected")
      console.log("Call status set to rejected")

      setIsRinging(false)
      onReject(incomingCall.id)
      setIncomingCall(null)
      setIsProcessing(false)
    } catch (error) {
      console.error("Error rejecting call:", error)
      setIsProcessing(false)
    }
  }

  if (!incomingCall || isProcessing) return null

  return (
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 z-[10000] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
      >
        <motion.div
          className="bg-gradient-to-br from-slate-800 to-slate-900 rounded-2xl p-8 text-white text-center max-w-sm w-full shadow-2xl border border-white/10"
          initial={{ scale: 0.8, y: 50 }}
          animate={{ scale: 1, y: 0 }}
          exit={{ scale: 0.8, y: 50 }}
          transition={{ type: "spring", stiffness: 300, damping: 30 }}
        >
          {/* Caller Avatar */}
          <motion.div
            className="relative mx-auto mb-6"
            animate={{
              scale: [1, 1.05, 1],
            }}
            transition={{
              duration: 2,
              repeat: Number.POSITIVE_INFINITY,
              ease: "easeInOut",
            }}
          >
            <Avatar className="h-24 w-24 mx-auto border-4 border-white/20 shadow-xl">
              <AvatarImage src={incomingCall.callerAvatar || "/placeholder.svg?height=96&width=96"} />
              <AvatarFallback className="bg-gradient-to-br from-purple-500 to-blue-500 text-white text-xl">
                {incomingCall.callerName.charAt(0).toUpperCase()}
              </AvatarFallback>
            </Avatar>

            {/* Pulse Animation */}
            <motion.div
              className="absolute inset-0 rounded-full border-2 border-white/30"
              animate={{
                scale: [1, 1.5, 2],
                opacity: [0.8, 0.3, 0],
              }}
              transition={{
                duration: 2,
                repeat: Number.POSITIVE_INFINITY,
                ease: "easeOut",
              }}
            />
          </motion.div>

          {/* Caller Name */}
          <h3 className="text-2xl font-bold mb-2">{incomingCall.callerName}</h3>

          {/* Call Type */}
          <div className="flex items-center justify-center space-x-2 mb-6">
            {incomingCall.type === "video" ? (
              <Video className="h-5 w-5 text-blue-400" />
            ) : (
              <Phone className="h-5 w-5 text-green-400" />
            )}
            <span className="text-white/80">Incoming {incomingCall.type} call</span>
          </div>

          {/* Action Buttons */}
          <div className="flex justify-center space-x-8">
            {/* Reject Button */}
            <motion.button
              className="p-4 rounded-full bg-red-500 hover:bg-red-600 text-white shadow-lg disabled:opacity-50"
              onClick={handleReject}
              disabled={isProcessing}
              whileHover={{ scale: isProcessing ? 1 : 1.1 }}
              whileTap={{ scale: isProcessing ? 1 : 0.9 }}
              animate={{
                boxShadow: [
                  "0 0 0 0 rgba(239, 68, 68, 0.7)",
                  "0 0 0 10px rgba(239, 68, 68, 0)",
                  "0 0 0 0 rgba(239, 68, 68, 0)",
                ],
              }}
              transition={{ duration: 1.5, repeat: Number.POSITIVE_INFINITY }}
            >
              <PhoneOff className="h-6 w-6" />
            </motion.button>

            {/* Accept Button */}
            <motion.button
              className="p-4 rounded-full bg-green-500 hover:bg-green-600 text-white shadow-lg disabled:opacity-50"
              onClick={handleAccept}
              disabled={isProcessing}
              whileHover={{ scale: isProcessing ? 1 : 1.1 }}
              whileTap={{ scale: isProcessing ? 1 : 0.9 }}
              animate={{
                boxShadow: [
                  "0 0 0 0 rgba(34, 197, 94, 0.7)",
                  "0 0 0 10px rgba(34, 197, 94, 0)",
                  "0 0 0 0 rgba(34, 197, 94, 0)",
                ],
              }}
              transition={{ duration: 1.5, repeat: Number.POSITIVE_INFINITY }}
            >
              <Phone className="h-6 w-6" />
            </motion.button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}
