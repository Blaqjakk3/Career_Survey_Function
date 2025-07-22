import { Client, Databases, Query } from 'node-appwrite';
import { GoogleGenerativeAI } from '@google/generative-ai';

export default async function (req, res) {
  try {
    // Initialize Appwrite client
    const client = new Client()
      .setEndpoint(req.variables.APPWRITE_ENDPOINT )
      .setProject(req.variables.APPWRITE_PROJECT_ID )
      .setKey(req.variables.APPWRITE_API_KEY);

    // Initialize Gemini AI
    const genAI = new GoogleGenerativeAI(req.variables.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const databases = new Databases(client);
    const userId = req.variables.APPWRITE_USER_ID;

    // Define database and collection IDs from appwrite.ts config
    const DATABASE_ID = req.variables.DATABASE_ID || 'career4me';
    const TALENTS_COLLECTION_ID = req.variables.TALENTS_COLLECTION_ID || 'talents';
    const CAREER_PATHS_COLLECTION_ID = req.variables.CAREER_PATHS_COLLECTION_ID || 'careerPaths';

    // Get user data
    const user = await databases.listDocuments(
      DATABASE_ID,
      TALENTS_COLLECTION_ID,
      [Query.equal("talentId", userId)]
    );

    if (user.documents.length === 0) {
      throw new Error("User not found");
    }

    const userData = user.documents[0];
    const careerStage = userData.careerStage;

    // Get all career paths
    const careerPaths = await databases.listDocuments(
      DATABASE_ID,
      CAREER_PATHS_COLLECTION_ID
    );

    // Prepare prompt based on career stage
    let prompt = `Based on the following user profile, recommend the top 3 career paths from the provided list. `;
    prompt += `User is a ${careerStage}.\n\n`;

    if (careerStage === "Pathfinder") {
      prompt += `User details:
      - Education: ${userData.degrees?.join(', ') || 'Not specified'}
      - Skills: ${userData.skills?.join(', ') || 'Not specified'}
      - Interests: ${userData.interests?.join(', ') || 'Not specified'}
      - Interested Fields: ${userData.interestedFields?.join(', ') || 'Not specified'}
      `;
    } else if (careerStage === "Trailblazer") {
      prompt += `User details:
      - Current Path: ${userData.currentPath || 'Not specified'}
      - Seniority Level: ${userData.currentSeniorityLevel || 'Not specified'}
      - Education: ${userData.degrees?.join(', ') || 'Not specified'}
      - Skills: ${userData.skills?.join(', ') || 'Not specified'}
      - Interests: ${userData.interests?.join(', ') || 'Not specified'}
      `;
    } else if (careerStage === "Horizon Changer") {
      prompt += `User details:
      - Current Path: ${userData.currentPath || 'Not specified'}
      - Seniority Level: ${userData.currentSeniorityLevel || 'Not specified'}
      - Education: ${userData.degrees?.join(', ') || 'Not specified'}
      - Skills: ${userData.skills?.join(', ') || 'Not specified'}
      - Interests: ${userData.interests?.join(', ') || 'Not specified'}
      - Interested Fields: ${userData.interestedFields?.join(', ') || 'Not specified'}
      `;
    }

    prompt += `\nAvailable Career Paths:\n`;
    careerPaths.documents.forEach(path => {
      prompt += `- ${path.title} (ID: ${path.$id}): ${path.description}\n`;
      prompt += `  Required Skills: ${path.requiredSkills?.join(', ') || 'None'}\n`;
      prompt += `  Required Interests: ${path.requiredInterests?.join(', ') || 'None'}\n`;
    });

    prompt += `\nProvide your response in JSON format with this structure:
    {
      "recommendations": [
        {
          "pathId": "career_path_id_1",
          "title": "Career Path Title 1",
          "matchScore": 90,
          "reason": "Detailed explanation why this is a good match",
          "improvementAreas": ["skill1", "skill2"]
        },
        {
          "pathId": "career_path_id_2",
          "title": "Career Path Title 2",
          "matchScore": 80,
          "reason": "Detailed explanation why this is a good match",
          "improvementAreas": ["skill1", "skill2"]
        },
        {
          "pathId": "career_path_id_3",
          "title": "Career Path Title 3",
          "matchScore": 75,
          "reason": "Detailed explanation why this is a good match",
          "improvementAreas": ["skill1", "skill2"]
        }
      ],
      "generalAdvice": "Overall career advice based on the user's profile"
    }`;

    // Get AI response
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    // Parse the JSON response
    let jsonResponse;
    try {
      // Clean the response text to remove any markdown formatting
      const cleanedText = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      jsonResponse = JSON.parse(cleanedText);
    } catch (e) {
      console.error("Failed to parse AI response:", text);
      // If JSON parsing fails, try to extract JSON from text
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          jsonResponse = JSON.parse(jsonMatch[0]);
        } catch (e2) {
          throw new Error("Failed to parse AI response as JSON");
        }
      } else {
        throw new Error("No valid JSON found in AI response");
      }
    }

    // Validate the response structure
    if (!jsonResponse.recommendations || !Array.isArray(jsonResponse.recommendations)) {
      throw new Error("Invalid response structure from AI");
    }

    // Update user's testTaken status
    await databases.updateDocument(
      DATABASE_ID,
      TALENTS_COLLECTION_ID,
      userData.$id,
      {
        testTaken: true
      }
    );

    // Prepare the response data
    const responseData = {
      success: true,
      recommendations: jsonResponse.recommendations,
      generalAdvice: jsonResponse.generalAdvice || "Continue developing your skills and exploring opportunities in your areas of interest.",
      careerStage
    };

    // Return the response using the correct Appwrite Cloud Function format
    return res.send(JSON.stringify(responseData), 200, {
      'Content-Type': 'application/json'
    });

  } catch (error) {
    console.error("Error in careerMatch function:", error);
    
    const errorResponse = {
      success: false,
      error: error.message || "An unknown error occurred"
    };
    
    // Return error response using the correct Appwrite Cloud Function format
    return res.json(JSON.stringify(errorResponse), 500, {
      'Content-Type': 'application/json'
    });
  }
}